const _ = require('lodash');
const zlog = require('zlog4js');
const assert = require('assert');
const lockService = require('./lock.service');
const syncHelper = require('./sync.helper');
const Zerror = require('./z-error');

const logger = zlog.getLogger('zerv/sync/update.service');

module.exports = {
    process,
};


/**
 * This function will merge the data with the original revision it came from
 * then it will provide the object changes to a handleConflict function
 *
 * from the handleConflict function, developer can look up the current version, check if the incremental changes are acceptable
 * Ex: Conflict rule: Change should be rejected if user has changed city but zip code was modified meanwhile
 * The update changes city on the original version. City was changed in the current version
 *
 * @param {*} data
 * @param {Function} fetchCurrentObjectRevision(id)
 * @param {*} saveUpdatedObject
 * @param {Object} option
 * - {Function} handleConflict(incrementalChange, data, currentObj, newObj)
 * - {Function} fetchObjectRevision(id, revision): must be provided if handle conflict is provided
 * - {function} updateObjectData(newObj, data): update data in newObj
 *   this can be useful when data is not an increment but some data to process before updating newObj
 * @returns {Object} incremental change with the new revision
 */

async function process(data, fetchCurrentObjectRevision, saveUpdatedObject, options = {}) {
    if (_.isNil(data.id)) {
        throw new Zerror('INCORRECT_INCREMENT', 'No object id provided in incremental data');
    }
    const lock = await lockService.getLock(data.id);
    try {
        if (_.isNil(data.revision)) {
            throw new Zerror('INCORRECT_INCREMENT', 'No revision provided in incremental data');
        }

        const currentObj = await fetchCurrentObjectRevision(data.id);
        const newObj = _.cloneDeep(currentObj);
        if (options.updateObjectData) {
            // custom logic to add data to an obj
            await options.updateObjectData(newObj, data);
        } else {
            // just merge maintaining data path
            syncHelper.mergeChanges(newObj, data);
        }

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
                if (!options.handleConflict) {
                    throw new Zerror('REVISION_CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + currentObj.revision);
                }
                assert(options.fetchObjectRevision, 'fetchObjectRevision must be provided to handle custom conflicts');
                const originObj = await options.fetchObjectRevision(data.id, data.revision);
                incrementalChange = syncHelper.differenceBetween(newObj, originObj);

                if (options.handleConflict(incrementalChange, data, currentObj, newObj)) {
                    throw new Zerror('RULE_CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + currentObj.revision);
                }
            }
            // the change is accepted to merge in current revision
        } else if (data.revision > currentObj.revision) {
            throw new Zerror('INCORRECT_REVISION', 'It is impossible to receive data based on a revision more recent than the current revision');
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
        // incrementalChange.source = data.source;
        incrementalChange.timestamp = data.timestamp;
        return incrementalChange;
    } finally {
        lock.release();
    }
}
