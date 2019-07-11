const _ = require('lodash');
const zlog = require('zlog4js');

const logger = zlog.getLogger('sync.helper');


const syncHelper = {
    differenceBetween,
    mergeChanges,
    processUpdate,
    processBasicUpdate
};

module.exports = syncHelper;


function differenceBetween(jsonObj1, jsonObj2) {
    if (_.isEmpty(jsonObj1) && _.isEmpty(jsonObj2)) {
        return null;
    }
    const objDifferences = {};
    _.forEach(_.keys(jsonObj1), property => {
        if (['id', 'revision'].indexOf(property) !== -1) {
            // there is no need to compare this.
            return;
        }
        if (_.isArray(jsonObj1[property])) {
            const obj1Array = jsonObj1[property];
            const obj2Array = jsonObj2[property];
            if (_.isEmpty(obj2Array)) {
                if (obj1Array.length) {
                    // add new array
                    objDifferences[property] = jsonObj1[property];
                }
                // same empty array
                return;
            }

            if (!obj1Array.length) {
                if (!obj2Array.length) {
                    // objects are both empty, so equals
                    return;
                }
                // obj2 is not empty
                // so obj1 does not have its data
                objDifferences[property] = [];
                return;
            }

            // does obj1 has its content managed by ids
            if (_.isNil(obj1Array[0].id)) {
                // no it is just a big array of data
                if (!_.isEqual(obj1Array, obj2Array)) {
                    objDifferences[property] = obj1Array;
                }
                return;
            }

            // since objects have ids, let's dig in to get specific difference
            const rowDifferences = [];
            for (let obj1Row of obj1Array) {
                const id = obj1Row.id;
                const obj2Row = _.find(obj2Array, { id });
                if (obj2Row) {
                    // is it updated?
                    const r = differenceBetween(obj1Row, obj2Row);
                    if (!_.isEmpty(r)) {
                        rowDifferences.push(_.assign({ id }, r));
                    }
                } else {
                    // row does not exist in the other obj
                    rowDifferences.push(obj1Row);
                }
            }
            // any row is no longer in obj1
            for (let obj2Row of obj2Array) {
                const id = obj2Row.id;
                const obj1Row = _.find(obj1Array, { id });
                if (!obj1Row) {
                    rowDifferences.push({ id, $removed: true });
                }
            }
            if (rowDifferences.length) {
                objDifferences[property] = rowDifferences;
            }
        } else if (_.isObject(jsonObj1[property])) {
            // what fields of the object have changed?
            if (jsonObj2[property]) {
                const r = differenceBetween(jsonObj1[property], jsonObj2[property]);
                if (!_.isEmpty(r)) {
                    objDifferences[property] = r;
                }
            } else {
                objDifferences[property] = jsonObj1[property];
            }
        } else if (jsonObj1[property] !== jsonObj2[property]) {
            // } && (_.isNull(newObj[key]) !== _.isNull(previousObj[key]))) {
            // what value has changed
            objDifferences[property] = jsonObj1[property];
        }
    });
    _.forEach(_.keys(jsonObj2), property => {
        if (_.keys(jsonObj1).indexOf(property) === -1) {
            objDifferences[property] = { $removed: true };
        }
    });
    return _.isEmpty(objDifferences) ? null : objDifferences;
}


function mergeChanges(jsonObj, changes) {
    _.forEach(changes, (newValue, property) => {
        if (property === 'id') {
            // id will never be different. they are just here to identity rows that contains new values
            return;
        }
        if (_.isArray(newValue)) {
            const changeArray = newValue;
            if (changeArray.length === 0 || _.isNil(changeArray[0].id)) {
                // a  array value is the new value
                // There is no id in the items, so there is no granular change.
                jsonObj[property] = changeArray;
            } else {
                _.forEach(changeArray, changeRow => {
                    const objRow = _.find(jsonObj[property], { id: changeRow.id });
                    if (objRow) {
                        if (changeRow.$removed) {
                            _.remove(jsonObj[property], objRow);
                        } else {
                            mergeChanges(objRow, changeRow);
                        }
                    } else {
                        jsonObj[property].push(changeRow);
                    }
                });
            }

            return;
        }
        if (_.isObject(newValue)) {
            if (newValue.$removed) {
                delete jsonObj[property];
            } else {
                mergeChanges(jsonObj[property], newValue);
            }
        } else {
            jsonObj[property] = newValue;
        }
    });
    return jsonObj;
}

/**
 * This function will merge the data with the current object revision
 * A basic conflict strategy would reject the data is the revision it based from is not the current one.
 * @param {*} data
 * @param {*} fetchCurrentObjectRevision
 * @param {*} saveUpdatedObject
 * @param {*} handleConflict
 *
 * @returns {Object} incremental change with the new revision
 */
function processBasicUpdate(data, fetchCurrentObjectRevision, saveUpdatedObject, handleConflict) {
    return processUpdate(data, fetchCurrentObjectRevision, syncHelper.mergeChanges, saveUpdatedObject, handleConflict);
}

/**
 * This function will merge the data with the original revision it came from
 * then it will provide the object changes to a handleConflict function
 *
 * from the handleConflict function, developer can look up the current version, check if the incremental changes are acceptable
 * Ex: Conflict rule: Change should be rejected if user has changed city but zip code was modified meanwhile
 * The update changes city on the original version. City was changed in the current version
 *
 *
 * @param {*} data
 * @param {Function} fetchObjectRevision
 *    - id
 *    - revision: if the revison is null, the function must return the most recent revision
 * @param {*} updateObjectData
 * @param {*} saveUpdatedObject
 * @param {*} handleConflict
 *
 * @returns {Object} incremental change with the new revision
 */
const locks = [];
async function getLock(id) {
    let handle = _.find(locks, { id });
    if (handle) {
        await handle.waitForRelease;
        return getLock(id);
    }
    handle = {};
    const waitForRelease = new Promise(function (resolve, reject) {
        handle.release = () => {
            delete handle.waitForRelease;
            _.remove(locks, handle);
            resolve();
        };
    });
    handle.id = id;
    handle.waitForRelease = waitForRelease;
    locks.push(handle);
    return handle;
}


async function processUpdate(data, fetchObjectRevision, updateObjectData, saveUpdatedObject, handleConflict) {
    if (_.isNil(data.id)) {
        throw new Error('INCORRECT_INCREMENT', 'No object id provided in incremental data');
    }
    const lock = await getLock(data.id);
    try {
        if (_.isNil(data.revision)) {
            throw new Error('INCORRECT_INCREMENT', 'No revision provided in incremental data');
        }

        const currentObj = await fetchObjectRevision(data.id);
        const newObj = _.cloneDeep(currentObj);
        await updateObjectData(newObj, data);

        // general logic to figure out the increment
        newObj.timestamp = data.timestamp;
        let incrementalChange;
        // If the revision received is based on old data, the currentObj is ahead
        if (data.revision < currentObj.revision) {
            if (data.timestamp.sessionId === currentObj.timestamp.sessionId) {
                // this new increment is coming from the same machine
                // most likely, the machine has not received yet the previous revision from sync, so it is still using the same revision number, so the db is already ahead
                // it is valid, as they come sequentially...
                logger.warn('Accept received new increment based on revision %b (db object on %b) since originated from same machine.', data.revision, currentObj.revision);
                // there is no conflict, so let's get the last revision.
                newObj.revision = currentObj.revision;
                incrementalChange = syncHelper.differenceBetween(newObj, currentObj);
            } else {
                if (!handleConflict) {
                    throw new Error('REVISION_CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + currentObj.revision);
                }

                const originObj = await fetchObjectRevision(data.id, data.revision);
                incrementalChange = syncHelper.differenceBetween(newObj, originObj);

                if (handleConflict(incrementalChange, data, currentObj, newObj)) {
                    throw new Error('RULE_CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + currentObj.revision);
                }
            }
            // the change is accepted to merge in current revision
        } else if (data.revision > currentObj.revision) {
            throw new Error('INCORRECT_REVISION', 'It is impossible to receive data based on a revision more recent than the current revision');
        } else {
            // there is No conflict, this is the difference to notify based on current data
            incrementalChange = syncHelper.differenceBetween(newObj, currentObj);
        }

        delete newObj.stamp;

        // no changes.. nothing to confirm.
        if (_.isEmpty(incrementalChange)) {
            return null;
        }
        // the newObj is supposed to be saved, and the incremental change notified.
        // the code in notification could also figure out the increment, if the originRevision is provided.
        await saveUpdatedObject(newObj, incrementalChange);

        incrementalChange.revision = newObj.revision;
        incrementalChange.stamp = data.stamp;
        //incrementalChange.source = data.source;
        incrementalChange.timestamp = data.timestamp;
        lock.release();
        return incrementalChange;
    } catch (err) {
        lock.release();
        throw err;
    }
}
