'strict mode';

const Promise = require('promise');
const _ = require('lodash');

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


Publication.prototype.formatNotifiedObject = function (dataNotification, object, notificationType) {
    try {
        const r = this.dataNotifications[dataNotification](object, notificationType, this.params);
        if (!r.then) {
            return Promise.resolve(r);
        }
        return r;
    } catch (err) {
        return Promise.reject(err);
    }
}
Publication.prototype.findSubscriptionsByTenantId = function (tenantId) {
    return _.filter(_.values(this.subscriptions), { tenantId: tenantId });
}

// in the process of refactoring to get publication and subscription in their own file.
// publication should own subscriptions, activeSubscriptions should be determined by looping over all subscriptions of each publication
Publication.prototype.notifySubscriptions = function (tenantId, dataNotification, notificationType, object, options) {
    const thisPublication = this;

    thisPublication.formatNotifiedObject(dataNotification, object, notificationType)
        .then(function (record) {
            thisPublication.findSubscriptionsByTenantId(tenantId)
                .forEach(function (subscription) {
                    try {
                        // make sure that the subscription is matching the notification params..so that we don't call the db for nothing!!
                        if (options.forceNotify === true || subscription.checkIfMatch(record)) {
                            // if alwaysFetch, all the records will be retrieved and pushed each time there is a notification (Db performance impact)
                            if (thisPublication.always) {
                                subscription.emitAllRecords();
                            } else {
                                subscription.emitChange(record, notificationType);
                            }
                        }
                    } catch (err) {
                        // unrecoverable error... check record validity.
                        logger.error(err, err.stack);
                    }
                });
        })
        .catch(function (err) {
            logger.error(err, err.stack);;
        });
}
