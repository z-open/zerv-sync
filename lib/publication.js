'strict mode';

const _ = require('lodash');
const zlog = require('zimit-zlog');
const utils= require('./utils');
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
        this.onSubscriptionDisconnect = options.onSubscriptionDisconnect;
        this.onSubscriptionConnect = options.onSubscriptionConnect;
    }
}

/**
 * Notify the data to the subscriptions if the data or their filter matches subscription criteria
 *
 * @param {String} tenantId
 * @param {String} dataNotification  which is the type of data being notified. 
 *                                   This is the value that is passed when calling zerv.notifyUpdate, notifyCreation, notifyRefresh
 *                                   so that the publication is aware to consider pushing notified data to its subscribers.
 * @param {String} notificationType  which could be ADD, UPDATE, DELETE
 * @param {Array} objects being notified, they must have a revision property and id
 * @param {Object} options
 *    @property {String} onlyUserId, if provided only the subscription matching the user id will be notified
 *    @property {Boolean} forceNotify, the data will be sent to the subscription eventhough the revision is not increased
 *                                      This can help to force the publication to reaply their filter
 *                                      and re-add an object that was removed
 *
 *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions.
 * 
 */
Publication.prototype.notifySubscriptions = async function(tenantId, dataNotification, notificationType, objects, options) {
    const promises = [];
    const tenantSubs = this.findSubscriptionsByTenantId(tenantId);
    if (!tenantSubs.length) {
        return;
    }
    try {
        const records = await this.preFormatNotifiedObjects(dataNotification, objects, notificationType);

        for (const subscription of tenantSubs) {
            if (!_.isNil(options.onlyUserId) && options.onlyUserId !== subscription.userId ) {
            // make sure only the specified user is notified, if option is provided.
                continue ;
            }
            promises.push(this.emitRecordsToSubscription(subscription, records, dataNotification, notificationType, options));
        }
    } catch(err) {
        logger.error(err, err.stack); ;
    }
    return Promise.all(promises).then(_.sum);
};

Publication.prototype.emitRecordsToSubscription = async function(subscription, records, dataNotification, notificationType, options) {
    // if alwaysFetch, all the records will be retrieved and pushed each time there is a notification (Db performance impact)
    // this can be useful for join query if data is defined with a proper record ID and revision number
    if (this.always) {
        return subscription.emitAllRecords();
    }

    const formattedRecords = await this.formatNotifiedObjectsWithSubscriptionParams(dataNotification, records, notificationType, subscription);

    const promises = [];
    const subRecords = [];
    for (const record of formattedRecords) {
        // this loop can be very demanding due to number of loops.
        // notify functions can be used to notify thousands and thousands of objects in servers with many publications/subscriptions, 
        // notifySubscriptions could take over the event loop and the entire node process.
        // freeing event queue will help by pausing adding more promises to the event loop at least in regarg to notification processing.
        await utils.breath();

        // figuring out what to emit is NOT serialized as the process depends on other asynchronous processes.
        promises.push((async () => {
            const recordToEmitBasedOnSubscriptionState = await this.prepareRecordToEmitToSubscription(subscription, record, dataNotification, notificationType);
            if (recordToEmitBasedOnSubscriptionState) {
                subRecords.push(recordToEmitBasedOnSubscriptionState);
            } 
        })());
    }
    return Promise.all(promises)
    .then(() => {
        if (!subRecords.length) {
            return 0;
        }
        return subscription.emitChanges(subRecords, options.forceNotify);
    });
};

Publication.prototype.prepareRecordToEmitToSubscription= async function(subscription, record, dataNotification, notificationType) {
    try {
        // make sure that the subscription is matching the notification params otherwise it might be a record that might need to be removed
        const isMatch = await subscription.checkIfMatch(record, dataNotification);
        const type = !isMatch ? 'REMOVAL' : notificationType;
        return { record, type };
    } catch (err) {
        // unrecoverable error... check record validity.
        logger.error(err, err.stack);
        return null;
    }
};

Publication.prototype.addSubscription = function(user, subscriptionId, params) {
    const subscription = new Subscription(user, subscriptionId, this, params);
    this.subscriptions[subscription.id] = subscription;
    if (this.onSubscriptionConnect) {
        subscription.onConnect((tenantId) => {
            this.onSubscriptionConnect(tenantId, user, params);
        });
    }
    return subscription;
};

// NOTE: NOT USED. Do not remove yet.
Publication.prototype.removeSubscription = function(subscription) {
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


Publication.prototype.formatNotifiedObjectsWithSubscriptionParams = async function(dataNotification, objects, notificationType, subscription) {
    const thisPub = this;
    const formatFn = thisPub.dataNotifications[dataNotification].format;
    if (!formatFn) {
        return objects;
    }
    // this could be a large number of objects to format
    return Promise.all(_.map(objects, (object) => 
        format(object, notificationType)
    ));

    async function format(object, notificationType) {
        // await utils.breath();
        try {
            const contextParams = _.assign(
                {tenantId: subscription.tenantId},
                subscription.params,
                subscription.additionalParams
            );
            const r = formatFn(object, notificationType, contextParams);

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
