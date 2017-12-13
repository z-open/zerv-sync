'strict mode';

const Promise = require('promise'),
zlog = require('zlog');
const _ = require('lodash');

Subscription = require('./subscription');

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

Publication.prototype.formatNotifiedObjects = function(dataNotification, objects, notificationType) {
    const thisPub = this;
    return Promise.all(_.map(objects, function(object) {
        return thisPub.formatNotifiedObject(dataNotification, object, notificationType);
    }));
};

Publication.prototype.formatNotifiedObject = function(dataNotification, object, notificationType) {
    try {
        const r = this.dataNotifications[dataNotification].format(object, notificationType, this.params);
        if (!r.then) {
            return Promise.resolve(r);
        }
        return r;
    } catch (err) {
        logger.error(err);
        return Promise.reject(err);
    }
};

Publication.prototype.findSubscriptionsByTenantId = function(tenantId) {
    return _.filter(_.values(this.subscriptions), {tenantId: tenantId});
};

// in the process of refactoring to get publication and subscription in their own file.
// publication should own subscriptions, activeSubscriptions should be determined by looping over all subscriptions of each publication
Publication.prototype.notifySubscriptions = function(tenantId, dataNotification, notificationType, objects, options) {
    const thisPublication = this;
    const tenantSubs = thisPublication.findSubscriptionsByTenantId(tenantId);
    if (!tenantSubs.length) {
        return;
    }
    thisPublication.formatNotifiedObjects(dataNotification, objects, notificationType)
        .then(function(records) {
            tenantSubs
                .forEach(function(subscription) {
                    let subRecords = [];
                    _.forEach(records, function(record) {
                        try {
                            // make sure that the subscription is matching the notification params..so that we don't call the db for nothing!!
                            if (options.forceNotify === true || subscription.checkIfMatch(record, dataNotification)) {
                                // if alwaysFetch, all the records will be retrieved and pushed each time there is a notification (Db performance impact)
                                if (thisPublication.always) {
                                    subRecords = null;
                                    subscription.emitAllRecords();
                                    return false; // stop iterating
                                } else {
                                    subRecords.push(record);
                                }
                            }
                        } catch (err) {
                            // unrecoverable error... check record validity.
                            logger.error(err, err.stack);
                        }
                    });
                    if (subRecords && subRecords.length) {
                        subscription.emitChanges(subRecords, notificationType);
                    }
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
