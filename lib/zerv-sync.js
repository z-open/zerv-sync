'strict mode';


/**
 * This module handles the data synchronization.
 *
 * Create a publication on the backend. the publication is set to listen to data changes
 * ex:
 *  sync.publish('tasks.sync',function(tenantId,userId,params,timestamp){
 *    return taskService.fetch(params,timestamp)
 * },[TASK_DATA]);
 * }
 *
 * subscribe to this publication on the client using the angular-sync lib.
 *
 * When your api update, create or remove data, notify the data changes on the backend. You might provide params that must be in the subscription to react.
 * ex:
 * function createTask(task) {
 *  ....
 *    return dataAccess.executeQuery(queryObj).then(function (r) {
        sync.notifyChanges('TASK_DATA', r);
        return r;
    });
 * }
 *
 * all and only client subscriptions registered to the publication listening to this data change will fetch the data from the db from their last timestamp.
 * then will receive the changes (PUSH) in their cache (use getData to get instance of the cache)
 *
 * Notes:
 * ------
 * If the client loses the connection it will re-use to the same subscription if the reconnection is fast enought. Otherwise it will re-subscribe.
 * While the client lost the connection, the subscription is caching any new notification in memory. When the client reconnects, it gets the data in the queue and acknowledge it received them.
 * If it loses the connection for a long period of time, the subcription will be destroyed...and the client will get all the data when it resubscribe.
 *
 * IMPORTANT: The client MUST reconnect on the same node server to get what is the queue for an existing subscription...otherwise it will resubscribe on the new node server and fetch all data.
 *
 */

const _ = require('lodash');
const zlog = require('zimit-zlog');
const UUID = require('uuid');

const Publication = require('./publication');
const Subscription = require('./subscription');
const zjsonbin = require('zjsonbin');
const updateService = require('./update.service');

let zervCore;
_.forIn(require.cache, function(required) {
    if (required.exports && required.exports.apiRouter) {
        zervCore = required.exports;
        return false;
    }
});
if (!zervCore) {
    zervCore = require('zerv-core');
}

let sync;
_.forIn(require.cache, function(required) {
    if (required.exports && required.exports.notifyCreation) {
        sync = required.exports;
        return false;
    }
});
// prevent creating another instance of this module
if (!sync) {
    const initRoutes = require('./routes');

    const clusterService = require('./clustering');

    UUID.generate = UUID.v4;

    const CURRENT_SYNC_VERSION = '1.4';
    const publications = {};
    const changeListeners = {};

    const logger = zlog.getLogger('zerv/sync');

    sync = {
        addRoutesTo,
        publish,
        subscribe,
        unsubscribe,
        notifyUpdate,
        notifyCreation,
        notifyDelete,
        notifyRefresh,

        onChanges: onDataChanges,
        getActiveSubscriptions,
        countActiveSubscriptions,
        setMaxDisconnectionTimeBeforeDroppingSubscription,
        getMaxDisconnectionTimeBeforeDroppingSubscription,
        getVersion,
        setLogLevel,
        dropActiveSubscriptions,
        unpublish,

        processUpdate: updateService.process,
        mergeChanges: zjsonbin.mergeChanges,
    };
    zervCore.addModule('Sync', sync);
    sync._processExternalRecordNotications = _processExternalRecordNotications;

    const cluster = clusterService.syncWithRedis(sync._processExternalRecordNotications, zervCore.transport);

    // add public functions to the core
    zervCore.addModule('Sync', sync);

    // //////////////// PUBLIC //////////////////////


    /**
     * add the routes to api
     *
     * @param {String} api: this is the api-router instance
     *
     */
    function addRoutesTo(api) {
        initRoutes(api, sync);
    }

    /**
     * retrieve the version of the sync library
     *
     * Note: Client library version must be same at the server's one to operate with.
     *
     * @returns current version (string)
     */
    function getVersion() {
        return CURRENT_SYNC_VERSION;
    }

    /**
     * subscribe to a publication.
     * If the subscription already exists on the server, reuse it.
     *
     * @param {Object} handler: handler passed by the api router event (later on, we will decouple and only pass socket and user objects)
     * @param {String} subscriptionId (optional): if the subscription already exists on the client, pass the id.
     * @param {String} publicationName: the name of the publication to register to
     * @param {Object} params: the object containing the parameters to pass to the publication
     */
    function subscribe(user, socket, subscriptionId, publicationName, params) {
        let subscription = findSubscription(subscriptionId);
        // prevent any other users except the owner to bind to an existing subscription
        if (subscription && user.id === subscription.userId && user.tenantId === subscription.tenantId) {
            // if the client provides the subscription id...most likely it losts the network connection and is trying to subscribe to any existing one....if the reconnection is fast enough, the subscription might be still, and what is still in the queue would be sent to it.
            subscription.debugSub('Reusing existing subscription before timeout.');
            bindSubscriptionToSocket(subscription, socket);
            if (subscription.hasDataToEmit()) {
                subscription.flush();
            }
            return subscription;
        }

        const publication = findPublicationByName(publicationName);
        if (subscriptionId) {
            subscription = publication.addSubscription(user, subscriptionId, params);
            subscription.debugSub('Resubscribe to ' + publication.name);
        } else {
            subscription = publication.addSubscription(user, UUID.generate(), params);
            subscription.logSub('New subscription to ' + publication.name + ' ' + JSON.stringify(params));
        }

        bindSubscriptionToSocket(subscription, socket);
        subscription.onRelease(() => releaseSubscriptionResources(subscription, cluster));

        if (!cluster) {
            subscription.emitAllRecords();
        } else {
            cluster.listenToTenantNotification(user.tenantId).then(function() {
                // make sure we do not miss any notification
                subscription.emitAllRecords();
            });
        }
        return subscription;
    }

    /**
     * Release all subscription resources
     * since the subscription is no longer needed when the subscriber does not longer connect to it
     * (network loss, log out, sub unsubscribed, browser refresh)
     * 
     * @param {Subscription} subscription 
     * @param {boolean} cluster 
     */
    function releaseSubscriptionResources(subscription, cluster) {
        const {tenantId, publication} = subscription;
        // notify disconnection
        if (!subscription.isDisconnectNotified && _.isFunction(publication.onSubscriptionDisconnect)) {
            subscription.isDisconnectNotified = true;
            publication.onSubscriptionDisconnect(subscription);
        }
        // If there is no longer any active subscription, 
        // then there is no longer need to listen to the cluster tenant channel.
        if (cluster && getActiveSubscriptions(tenantId).length === 0) {
            cluster.releaseTenantNotificationListener(tenantId);
        }
    }

    /**
     * Unsubscribe a subscription to a publication
     *
     * @param {String} tenantId: the owner tenant id of the subscription
     * @param {Uid} userId: the owner id of the subscription
     * @param {string} subscriptionId
     */
    function unsubscribe(user, subscriptionId) {
        const subscription = findSubscription(subscriptionId);
        // prevent any other users except the owner to release an existing subscription
        if (subscription && user.id === subscription.userId && user.tenantId === subscription.tenantId) {
            subscription.release();
            // at this point, the subscription is removed from memory with its cache and its pointer;
        }
    }

    /**
     * Retrieve the active subscriptions
     *
     * Later on could be used to define current user activity.
     */
    function getActiveSubscriptions(tenantId) {
        const subs = [];
        _.forIn(publications, function(publication) {
            Array.prototype.push.apply(subs, publication.getSubscriptions(tenantId));
        });

        return subs;
    }

    function findSubscription(subId) {
    // can be optimized...
        return _.find(getActiveSubscriptions(), { id: subId });
    }

    /**
     *
     * count the current number of active subscriptions
     *
     * Besides testing, it is a server load indicator.
     */
    function countActiveSubscriptions() {
        return getActiveSubscriptions().length;
    }

    /**
     * set Max Disconnection Time Before Dropping Subscription
     *
     * Usually when a client losses the network, it is temporary,
     * This will prevent from fetching data (access db) if the client reconnects fast enough.
     * This will also improve over all server response time.
     *
     * @param valueInSeconds
     *
     */
    function setMaxDisconnectionTimeBeforeDroppingSubscription(valueInSecondes) {
        Subscription.maxDisconnectionTimeBeforeDroppingSubscription = valueInSecondes;
    }

    function getMaxDisconnectionTimeBeforeDroppingSubscription() {
        return Subscription.maxDisconnectionTimeBeforeDroppingSubscription;
    }

    /**
     * force sync to show debug information
     *
     */
    function setLogLevel(value) {
        logger.setLevel(value);
    }

    /**
     * drop all active subscriptions from this server.
     *
     * This is used for test purposes.
     */
    function dropActiveSubscriptions() {
        getActiveSubscriptions().forEach(function(subscription) {
            subscription.release();
        });
    // _.values(activeSubscriptions).forEach(function (subscription) {
    //     subscription.release();
    // })
    }

    /**
     * unpublish a publication from this server only and drop all its subscriptions.
     *
     * This is used for test purposes for now.
     */
    function unpublish(publicationName) {
        const publication = publications[publicationName];
        if (!publication) {
            throw new Error('Unknown publication ' + publicationName);
        }
        publication.getAllSubscriptions().forEach(function(subscription) {
            subscription.release();
        });
        delete publications[publicationName];
    }

    /**
     * Define a new publication which can be subscribe to.
     *
     * @param {String} name : the name of the publication the client can subscripbe too
     * @param {Function} fetchFn: the function that will return a promise with the array of data pulled. this function will receive the params passed by the subscription if any.
     * @param <string or object> dataNotification. When data is updated, deleted or added, it should be notified with this value for the publication to push the changes (if they match its subscription params)
     *          - {String} representing the notification event.
     *          - {Object} object with property name being the event, the value being the function to execute againt the object/record to be notified.following properties
     *            ex: a subscription subscribe to a publication of Male census (each time a  adult registration is updated/created, the subscription to this publication will receive this person)
     *              {
     *                  ADULT: {
     *                          format: function(adultRegistration) {
     *                              return new Person( adultRegistration);
     *                          },
     *                          filter: function(adultRegistration, parameters) {
     *                              return paramaters.gender === adultRegistration.gender;
     *                          }
     *                  },
     *                  CHILD: {
     *                          format: function(childRegistration) { return new Person(childRegistration); }
     *                  }
     *              }
     *
     * @param {Object} options: object with followings:
     *          - {Function} init: function to provided additional params that will be used to check if a subscription listens to the notified data(new, updated or removed data),
     *          - <boolean> once: when true, the publication will push the data once only, if there is notification, data will not be pushed but if the network fails data will be pushed again
     *          - <boolean> always: when true, the publication will push all data when it is notified instead of just the record being notified
     */
    function publish(name, fetchFn, dataNotification, options) {
        if (publications[name]) {
            logger.trace('Publication [' + name + '] is overidden.');
            unpublish(name);
        }

        let dataNotifications;

        if (!dataNotification) {
            if (!options || !options.once) {
                // without this the subscription would not know when there is a change in a table
                throw (new Error('Missing or incorrect data notification when registering publication [' + name + ']'));
            }
        } else if (typeof dataNotification === 'string') {
            dataNotifications = {};
            dataNotifications[dataNotification] = {};
        } else {
            // dataNotification is an object:
            // ex: {USER_DATA:function(record) { return superUser(record)}};
            // or ex: {USER_DATA: { format: function(record) { return superUser(record)}};
            dataNotifications = {};
            _.forEach(dataNotification, function(value, key) {
                if (_.isFunction(value)) {
                    dataNotifications[key] = {
                        format: value
                    };
                } else {
                    dataNotifications[key] = {
                        format: value.format || null,
                        filter: value.filter
                    };
                }
            });
        }

        publications[name] = new Publication(name, fetchFn, dataNotifications, options);
        return sync;
    }


    /**
     * Register a callback on data changes for a specific data notification
     *
     * Note: the call back would be run in all the nodes of a clusters except when using option localOnly
     *
     * @param {String} dataNotification
     * @param {Function} callback which returns a promise;
     * @param {Object} options 
     * @property {boolean} options.localOnly Only listen to notifications made by the local server.
     * @returns {function} to remove the listener
     */
    function onDataChanges(dataNotification, callback, options = {}) {
        let listeners = changeListeners[dataNotification];
        if (!listeners) {
            listeners = {};
            changeListeners[dataNotification] = listeners;
        }
        const listenerId = UUID.generate();
        listeners[listenerId] = {
            localOnly: options.localOnly,
            callback
        };
        return () => delete listeners[listenerId];
    }

    /**
     * Notify a record creation.
     * Before notifying, make sure the record revision was increased
     *
     * @param {uid} tenantId,
     * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
     * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
     * 
     *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions.
     * Notes:
     * TO REMOVE!!! Options: {boolean} [forceNotify=false] Notify even if there was no match with the record.
     */
    function notifyCreation(tenantId, dataNotification, object, options) {
        return notifyRecordActivity(tenantId, dataNotification, 'ADD', object, options);
    }

    /**
     * Notify a record removal.
     * Before notifying, make sure the record revision was increased.
     *
     * @param {uid} tenantId,
     * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
     * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
     *
     * 
     *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions.
     */
    function notifyDelete(tenantId, dataNotification, object, options) {
        return notifyRecordActivity(tenantId, dataNotification, 'REMOVAL', object, options);
    }

    /**
     * Notify a record update.
     * Before notifying, make sure the record revision was increased
     *
     * @param {uid} tenantId,
     * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
     * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
     * 
     *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions.
     */
    function notifyUpdate(tenantId, dataNotification, object, options) {
        return notifyRecordActivity(tenantId, dataNotification, 'UPDATE', object, options);
    }

    /**
     * Notify a record all subscriptions to recompute their publication filter. you may not increase the revision.
     * if the publication has a filter that is based on other data that might have changed than the notified object
     *
     * This is way more effective than forcing all subscriptions to re-initialize (which would lead all subscriptions to
     * pull data from the persistence media).
     *
     * @param {uid} tenantId,
     * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
     * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
     * 
     *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions.
     */
    function notifyRefresh(tenantId, dataNotification, object, options) {
        return notifyRecordActivity(tenantId, dataNotification, 'UPDATE', object, _.assign({}, options, {forceNotify: true}));
    }

    // //////////////// HELPERS //////////////////////

    /**
     *  Notify subscriptions of the publication listening to the dataNotification
     *  Client subscriptions will receive a sync if their param conditions match the notified objects.
     *  @param {string} tenantId
     *  @param {string} dataNotification
     *  @param {String} notificationType
     *  @param {array} objects or single object
     *  @param {Object} options
     * 
     *  @returns {Promise<number>} number of notifications which are scheduled to be emitted to the interested subscriptions
     * 
     */
    function notifyRecordActivity(tenantId, dataNotification, notificationType, objects, options) {
        if (!_.isArray(objects)) {
            objects = [objects];
        }

        // nothing to notify?
        if (!objects.length) {
            return Promise.resolve(0);
        }

        options = options || {};

        if (cluster) {
            cluster.broadcast(tenantId, dataNotification, notificationType, objects, options);
        };

        return processRecordNotifications(tenantId, dataNotification, notificationType, objects, options);
    }

    function _processExternalRecordNotications(tenantId, dataNotification, notificationType, objects, options) {
        options = _.assign({clusterSrc: true}, options);
        return processRecordNotifications(tenantId, dataNotification, notificationType, objects, options);
    }

    async function processRecordNotifications(tenantId, dataNotification, notificationType, objects, options) {
        notifyChangeListeners(tenantId, dataNotification, notificationType, objects, options);

        const publications = findPublicationsListeningToDataNotification(dataNotification);
        let objectsNotifiedTotal = 0;
        for (const publication of publications) {
            objectsNotifiedTotal += await publication.notifySubscriptions(tenantId, dataNotification, notificationType, objects, options);
        }
        return objectsNotifiedTotal;
    }

    /**
     * All listeners to the onchange event will run their callback
     * an error is displayed for all failing callbacks.
     *
     *  @param {String} tenantId
     *  @param {string} dataNotification
     *  @param {String} notificationType
     *  @param {array} records
     *  @param {Object} options
     */
    function notifyChangeListeners(tenantId, dataNotification, notificationType, records, options) {
        const listeners = changeListeners[dataNotification];
        if (listeners) {
            _.forEach(listeners, (listener) => {  
                if (options && (!options.clusterSrc || !listener.localOnly)) {
                    _.forEach(records, function(record) {
                        // this make sure we show most silent error. If callback deals with promises it should return a promise
                        try {
                            const r = listener.callback(tenantId, record, notificationType, options);
                            if (r && r.then) {
                                r.catch(function(err) {
                                    logger.error('Error in callback of the notification listener %b.', dataNotification, err.stack || err);
                                });
                            }
                        } catch (err) {
                            logger.error('Error in callback of the notification listener %b.', dataNotification, err.stack || err);
                        }
                    });
                }
            });
        }
    }


    function findPublicationsListeningToDataNotification(dataNotification) {
        const r = [];
        _.forEach(publications, (publication, publicationName) => {
            if (publication.dataNotifications && publication.dataNotifications[dataNotification]) {
                r.push(publications[publicationName]);
            }
        });
        return r;
    }

    function findPublicationByName(publicationName) {
        const publication = publications[publicationName];
        if (!publication) {
            throw (new Error('Subscription to inexisting publication [' + publicationName + ']'));
        }
        return publication;
    }

    function bindSubscriptionToSocket(subscription, socket) {
        subscription.socket = socket;
        subscription.transport = zervCore.transport; // contains functin to serialize/deserialize// need refactor.
        subscription.isDisconnectNotified = false; // the sub just getting bound/or rebound, so disconnect event has not been notified.

        // the subscription just got connected or reconnected
        if (_.isFunction(subscription.publication.onSubscriptionConnect)) {
            subscription.publication.onSubscriptionConnect(subscription);
        }

        // let's track bound subscription so that they can be discarded in case of socket disconnection.
        if (!socket.subscriptions) {
            socket.subscriptions = [];
            unbindAllSubscriptionOnSocketDisconnect(socket);
            socket.subscriptions.push(subscription); ;
        } else if (socket.subscriptions.indexOf(subscription) === -1) {
            socket.subscriptions.push(subscription);
        }
    }

    function unbindAllSubscriptionOnSocketDisconnect(socket) {
        socket.on('disconnect', function() {
            // release socket instance from its subscriptions...
            const socketSubscriptions = socket.subscriptions;
            socket.subscriptions = [];
            socketSubscriptions.forEach(function(subscription) {
                subscription.debugSub('Unbound due to disconnection.');
                // disconnectEvent might have already ben notified
                if (!subscription.isDisconnectNotified && _.isFunction(subscription.publication.onSubscriptionDisconnect)) {
                    subscription.isDisconnectNotified = true;
                    subscription.publication.onSubscriptionDisconnect(subscription);
                }
                subscription.socket = null;
            });
            // then give a change to reuse the subscription if the client reconnects fast enough, otherwise unsubscribe all subscriptions from this socket.
            setTimeout(function() {
                socketSubscriptions.forEach(function(subscription) {
                    // if there is a socket it would be a new one, not the one is disconnected.  so the subscription has been reactivated on the new socket (client reconnected)
                    if (!subscription.socket) {
                        subscription.debugSub('Timeout. Discarding Subscription. No longer in use.');
                        unsubscribe(subscription.user, subscription.id);
                    }
                });
            }, Subscription.maxDisconnectionTimeBeforeDroppingSubscription * 1000);
        });
    }
}

module.exports = sync;
