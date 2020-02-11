'strict mode';

const Promise = require('promise'),
  zlog = require('zlog4js');
const _ = require('lodash');

const Subscription = require('./subscription');

const logger = zlog.getLogger('zerv/sync/publication');

module.exports = Publication;

function Publication(name, fetchFn, dataNotifications, options) {
  this.name = name;
  this.fn = fetchFn;
  this.dataNotifications = dataNotifications;
  this.subscriptions = {};
  if (options) {
    this.init = options.init; // option to provide third params
    this.once = options.once; // will publish only once..then unsubscribe the client
    this.always = options.always; // will push all data each time there is a notification
  }
}

/**
 * Notify the data to the subscriptions if the data or their filter matches subscription criteria
 *
 * @param {String} tenantId
 * @param {String} dataNotification  which is the type of data being notified
 * @param {String} notificationType  which could be ADD, UPDATE, DELETE
 * @param {Array} objects being notified, they must have a revision property and id
 * @param {Object} options
 *    @property {String} onlyUserId, if provided only the subscription matching the user id will be notified
 *    @property {Boolean} forceNotify, the data will be sent to the subscription eventhough the revision is not increased
 *                                      This can help to force the publication to reaply their filter
 *                                      and re-add an object that was removed
 *
 */
Publication.prototype.notifySubscriptions = function(tenantId, dataNotification, notificationType, objects, options) {
  const thisPublication = this;
  const tenantSubs = thisPublication.findSubscriptionsByTenantId(tenantId);
  if (!tenantSubs.length) {
    return;
  }
  thisPublication.preFormatNotifiedObjects(dataNotification, objects, notificationType)
      .then(function(records) {
        tenantSubs
            .forEach(function(subscription) {
              // if alwaysFetch, all the records will be retrieved and pushed each time there is a notification (Db performance impact)
              // this can be useful for join query if data is defined with a proper record ID and revision number
              if (thisPublication.always) {
                return subscription.emitAllRecords();
              }

              return thisPublication.formatNotifiedObjectsWithSubscriptionParams(dataNotification, records, notificationType, subscription)
                  .then(async (records) => {
                    const subRecords = [];
                    for (const record of records) {
                      if (!_.isNil(options.onlyUserId) && options.onlyUserId !== subscription.userId ) {
                        // make sure only the specified user is notified, if option is provided.
                        continue;
                      }
                      try {
                        // make sure that the subscription is matching the notification params otherwise it might be a record that might need to be removed
                        const isMatch = await subscription.checkIfMatch(record, dataNotification);
                        const type = ! isMatch ? 'REMOVAL' : notificationType;

                        subRecords.push({record, type});
                      } catch (err) {
                        // unrecoverable error... check record validity.
                        logger.error(err, err.stack);
                      }
                    }
                    if (subRecords.length) {
                      subscription.emitChanges(subRecords, options.forceNotify);
                    }
                  });
            });
      })
      .catch(function(err) {
        logger.error(err, err.stack); ;
      });
};


Publication.prototype.addSubscription = function(user, subscriptionId, params) {
  const subscription = new Subscription(user, subscriptionId, this, params);
  this.subscriptions[subscription.id] = subscription;
  return subscription;
};


Publication.prototype.removeSubscription = function(subscriptionId) {
  const sub = this.subscriptions[subscription.id];
  if (sub) {
    sub.release();
  }
};


Publication.prototype.getSubscriptions = function(tenantId) {
  const subs = _.values(this.subscriptions);
  return tenantId ? _.filter(subs, {tenantId}) : subs;
};

Publication.prototype.getAllSubscriptions = function(tenantId) {
  const subs = _.values(this.subscriptions);
  return subs;
};

Publication.prototype.findSubscriptionsByTenantId = function(tenantId) {
  return _.filter(_.values(this.subscriptions), {tenantId: tenantId});
};


Publication.prototype.formatNotifiedObjectsWithSubscriptionParams = function(dataNotification, objects, notificationType, subscription) {
  const thisPub = this;
  return Promise.all(_.map(objects, function(object) {
    return format(dataNotification, object, notificationType);
  }));

  function format(dataNotification, object, notificationType) {
    try {
      const contextParams = _.assign(
          {tenantId: subscription.tenantId},
          subscription.params,
          subscription.additionalParams
      );
      const r = thisPub.dataNotifications[dataNotification].format(object, notificationType, contextParams);

      if (!r.then) {
        return Promise.resolve(r);
      }
      return r;
    } catch (err) {
      logger.error('Notification Format Error.', err);
      return Promise.reject(err);
    }
  };
};


/**
 * There is no implementation at this point as there is no publication option for this.
 * global formatting would prevent using sub params to format the object.
 * It would factor and remove some heavy processing done by the formatNotifiedObjectsWithSubscriptionParams each time the notification is checked against subscription.
 */
Publication.prototype.preFormatNotifiedObjects = function(dataNotification, objects, notificationType) {
  return Promise.resolve(objects);
};
