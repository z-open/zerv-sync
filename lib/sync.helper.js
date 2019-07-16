'strict mode';
const _ = require('lodash');
const zlog = require('zlog4js');
const assert =  require('assert');

const logger = zlog.getLogger('sync.helper');


const syncHelper = {
    differenceBetween,
    mergeChanges,
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

