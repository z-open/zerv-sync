'strict mode';
const _ = require('lodash');
const zlog = require('zlog4js');

const logger = zlog.getLogger('zerv/sync/lock.service');

module.exports = {
  getLock
};

const locks = [];

/**
 * This simple facility only locks the access to an object on a single server.
 * It provides higher guarantees that fast updates will not be processed in parrallele for processes using this facility.
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
 * 2/ But if the process cannot be rollback. A simpler transaction scheme might be used to prevent access to some objects.
 * the functionality should use redis to publish the lock.
 * Using the getLock would be needed to use in the entire application to decrease probability of data corruption.
 * lock should have a life span.
 *
 * @param {String} uniqRef: this is preferably the id of the object that is being locked for update or any hashtag that can identify a shared transaction.
 * @returns {Object} the lock.
 *  contains the function release() to release the lock
 */
async function getLock(uniqRef) {
  let handle = _.find(locks, { id: uniqRef });
  if (handle) {
    logger.info('wait for lock on %s', uniqRef);
    await handle.waitForRelease;
    return getLock(uniqRef);
  }

  logger.info('new lock on %s', uniqRef);
  handle = {};
  handle.id = uniqRef;
  handle.waitForRelease = new Promise(function(resolve, reject) {
    handle.release = () => {
      logger.info('release lock %s', uniqRef);
      _.remove(locks, handle);
      resolve(true);
    };
  });
  locks.push(handle);
  return handle;
}
