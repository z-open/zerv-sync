'strict mode';
const _ = require('lodash');
const zlog = require('zlog4js');

const logger = zlog.getLogger('zerv/sync/lock.service');

module.exports = {
    getLock
};

let lockn = 0;
const locks = [];

/**
 * This simple facility only locks the access to an object on a single server.
 * It guarantes that fast updates will not be processed in parrallele.
 * In the multi server environment, it still reduces greatly the changes of corrupting data on concurrent update.
 *
 *
 * Locking is crucial.
 * During an update process, the db might change states. Concurrent update will most likely failed ending up using incorrect revision number. It is totally unpredictable.
 *
 * Note:
 * -----
 * 1/ The proper way is to use db transaction.
 *
 * 2/ But if the process cannot be rollback. A simpler transaction scheme might be used to prevent access to some object.
 * the functionality should use redis to publish the lock.
 * Using the getLock would be needed to use in the entire application to decrease probability of data corruption. 
 * lock should have a life span.
 * 
 * @param {*} id 
 * @returns {Object} the lock.
 *  contains function release to release the lock
 */
async function getLock(id) {
    let handle = _.find(locks, { id });
    if (handle) {
        logger.info('wait for lock on %s', id);
        await handle.waitForRelease;
        return getLock(id);
    }

    logger.info('new lock on %s', id);
    handle = {};
    handle.id = id;
    handle.waitForRelease = new Promise(function(resolve, reject) {
        handle.release = () => {
            logger.info('release lock %s', id);
            _.remove(locks, handle);
            resolve(true);
        };
    });
    locks.push(handle);
    return handle;
}
