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

const Promise = require('promise'),
    zlog = require('zlog'),
    UUID = require('uuid'),
    _ = require('lodash');

const Publication = require('./publication'),
    Subscription = require('./subscription');

let zervCore;
_.forIn(require.cache, function (required) {
    if (required.exports && required.exports.apiRouter) {
        zervCore = required.exports;
        return false;
    }
});
if (!zervCore) {
    zervCore = require('zerv-core');
}

let zervSync;
_.forIn(require.cache, function (required) {
    if (required.exports && required.exports.notifyCreation) {
        zervSync = required.exports;
        return false;
    }
});
// prevent creating another instance of this module
if (zervSync) {
    module.exports = zervSync;
    return;
}

const initRoutes = require('./routes')

UUID.generate = UUID.v4;

const CURRENT_SYNC_VERSION = '1.2';
const publications = {};
const changeListeners = [];

const logger = zlog.getLogger('zerv/sync');

const sync = {
    addRoutesTo,
    publish,
    subscribe,
    unsubscribe,
    notifyUpdate,
    notifyCreation,
    notifyDelete,

    onChanges: onDataChanges,
    getActiveSubscriptions,
    countActiveSubscriptions,
    setMaxDisconnectionTimeBeforeDroppingSubscription,
    getMaxDisconnectionTimeBeforeDroppingSubscription,
    getVersion,
    setLogLevel,
    dropActiveSubscriptions
};

zervCore.addModule('Sync', sync);



module.exports = sync;

////////////////// PUBLIC //////////////////////


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
    var subscription = findSubscription(subscriptionId);
    // prevent any other users except the owner to bind to an existing subscription
    if (subscription && user.id === subscription.userId && user.tenantId === subscription.tenantId) {
        // if the client provides the subscription id...most likely it losts the network connection and is trying to subscribe to any existing one....if the reconnection is fast enough, the subscription might be still, and what is still in the queue would be sent to it.
        subscription.debugSub('Reusing existing subscription before timeout.');
        bindSubscriptionToSocket(subscription, socket);
        if (subscription.hasDataToEmit()) {
            subscription.emitQueue();
        }
        return subscription;
    }

    var publication = findPublicationByName(publicationName);
    if (subscriptionId) {
        subscription = new Subscription(user, subscriptionId, publication, params);
        subscription.debugSub('Resubscribe to ' + publication.name);
    } else {
        subscription = new Subscription(user, UUID.generate(), publication, params);
        subscription.logSub('New subscription to ' + publication.name + ' ' + JSON.stringify(params));
    }
    publication.subscriptions[subscription.id] = subscription;
    bindSubscriptionToSocket(subscription, socket);
    subscription.emitAllRecords();

    return subscription;
}

/**
 * Unsubscribe a subscription to a publication
 *  
 * @param {String} tenantId: the owner tenant id of the subscription
 * @param {Uid} userId: the owner id of the subscription
 * @param {string} subscriptionId
 */
function unsubscribe(user, subscriptionId) {
    var subscription = findSubscription(subscriptionId);
    // prevent any other users except the owner to release an existing subscription
    if (subscription && user.id == subscription.userId && user.tenantId === subscription.tenantId) {
        subscription.release();
        // at this point, the subscription is removed from memory with its cache and its pointer;
    }
}

/**
 * Retrieve the active subscriptions
 * 
 * For testing purposes. Later on could be used to define current user activity.
 */
function getActiveSubscriptions() {
    // should only collect indicators from subscription instances.
    const subs = [];
    var t = _.forIn(publications, function (publication) {
        Array.prototype.push.apply(subs, _.values(publication.subscriptions));
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
    getActiveSubscriptions().forEach(function (subscription) {
        subscription.release();
    });
    // _.values(activeSubscriptions).forEach(function (subscription) {
    //     subscription.release();
    // })
}

/**
 * Define a new publication which can be subscribe to.
 * 
 * @param {String} name : the name of the publication the client can subscripbe too
 * @param {Function} fetchFn: the function that will return a promise with the array of data pulled. this function will receive the params passed by the subscription if any.
 * @param <string or object> dataNotification. When data is updated, deleted or added, it should be notified with this value for the publication to push the changes (if they match its subscription params)
 *          - {String} representing the notification event.
 *          - {Object} object with property name being the event, the value being the function to execute againt the object/record to be notified.following properties
 *            ex: publication of census (each time a adult registration is updated/created, the subscription to this publication will receive this person)
 *              {
 *                  ADULT: function(adultRegistration) { return new Person( adultRegistration); }}    
 *                  CHILD: function(childRegistration) { return new Person(childRegistration);}
 *              }
 *                 
 * @param {Object} options: object with followings:
 *          - {Function} init: function to provided additional params that will be used to check if a subscription listens to the notified data(new, updated or removed data),
 *          - <boolean> once: when true, the publication will push the data once only, if there is notification, data will not be pushed but if the network fails data will be pushed again
 *          - <boolean> always: when true, the publication will push all data when it is notified instead of just the record being notified
 */
function publish(name, fetchFn, dataNotification, options) {
    var dataNotifications;

    if (!dataNotification) {
        if (!options || !options.once) {
            // without this the subscription would not know when there is a change in a table
            throw (new Error('Missing or incorrect data notification when registering publication [' + name + ']'));
        }
    } else if (typeof dataNotification === 'string') {
        dataNotifications = {};
        dataNotifications[dataNotification] = function (record) {
            return Promise.resolve(record);
        }
    } else {
        // dataNotification is an object:
        // ex: {USER_DATA:function(record) { return superUser(record)}};
        dataNotifications = dataNotification;
    }

    publications[name] = new Publication(name, fetchFn, dataNotifications, options);
    return sync;
}



/**
 * Register a callback on data changes
 *
 * Note: the call back would be run in all the nodes of a clusters. So it might not be a good option if the callback is supposed to only be run once in the system.
 *
 * @param {String} dataNotification
 * @param {Function} callback which returns a promise;
 *
 *  if the promise fails, an error will be logged.
 *
 */
function onDataChanges(dataNotification, callback) {
    var listeners = changeListeners[dataNotification];
    if (!listeners) {
        listeners = [];
        changeListeners[dataNotification] = listeners;
    }
    listeners.push(callback);
    return sync;
}

/**
 * Notify a record creation. 
 * Before notifying, make sure the record revision was increased
 * 
 * @param {uid} tenantId,
 * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
 * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
 *  
 * Notes:
 * TO REMOVE!!! Options: {boolean} [forceNotify=false] Notify even if there was no match with the record.
 */
function notifyCreation(tenantId, dataNotification, object, options) {
    notifyRecordActivity(tenantId, dataNotification, 'ADD', object, options);
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
 */
function notifyDelete(tenantId, dataNotification, object, options) {
    notifyRecordActivity(tenantId, dataNotification, 'REMOVAL', object, options);
}

/**
 * Notify a record update. 
 * Before notifying, make sure the record revision was increased
 * 
 * @param {uid} tenantId,
 * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
 * @param {array/object} record: Object/Record to notify to listening publication (must at least have an id and revision number)
 *  
 * Notes:
 * TO REMOVE!!! Options: {boolean} [forceNotify=false] Notify even if there was no match with the record.
 */
function notifyUpdate(tenantId, dataNotification, object, options) {
    notifyRecordActivity(tenantId, dataNotification, 'UPDATE', object, options);
}




////////////////// HELPERS //////////////////////

/**
 *  Notify subscriptions of the publication listening to the dataNotification
 *  Client subscriptions will receive a sync if their param conditions match the notified objects.
 *  @param {string} tenantId
 *  @param {string} dataNotification
 *  @param {String} notificationType
 *  @param {array} records
 *  @param {Object} options 
 */
function notifyRecordActivity(tenantId, dataNotification, notificationType, objects, options) {
    if (!_.isArray(objects)) {
        objects = [objects];
    }

    options = options || {}

    notifyChangeListeners(tenantId, dataNotification, notificationType, objects, options);

    notifyCluster(tenantId, dataNotification, notificationType, objects, options);

    findPublicationsListeningToDataNotification(dataNotification)
        .forEach(function (publication) {
            publication.notifySubscriptions(tenantId, dataNotification, notificationType, objects, options);
        });
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
    var listeners = changeListeners[dataNotification];
    if (listeners) {
        listeners.forEach(function (callback) {
            // this make sure we show most silent error. If callback deals with promises it should return a promise
            try {
                var r = callback(tenantId, records, notificationType, options);
                if (r && r.then) {
                    r.catch(function (err) {
                        logger.error('Error in callback of the notification listener %b.', dataNotification, err.stack || err);
                    });
                }
            } catch (err) {
                logger.error('Error in callback of the notification listener %b.', dataNotification, err.stack || err);
            }
        });
    }
}

/**
 * The notification should be able to reach any node server related to this tenant
 * Potential users of a tenant might have their socket connected to publication located on other servers.
 * 
 * Note: Other solution might be considered (clustering/ load balancing/ single server capabiblities, etc)
 * @param {String} tenantId
 * @param {String} dataNotification:   string to define the type of object we are notifying and publications are potentially listening to.
 * @param {Array} records: Object/Record to notify to listening publication
 * 
 */
function notifyCluster(tenantId, dataNotification, records, options) { }


function findPublicationsListeningToDataNotification(dataNotification) {
    var r = [];
    for (var publicationName in publications) {
        var publication = publications[publicationName];
        if (publication.dataNotifications && publication.dataNotifications[dataNotification]) {
            r.push(publications[publicationName]);
        }
    }
    return r;
}

function findPublicationByName(publicationName) {
    var publication = publications[publicationName];
    if (!publication) {
        throw (new Error('Subscription to inexisting publication [' + publicationName + ']'));
    }
    return publication;
}

function bindSubscriptionToSocket(subscription, socket) {
    subscription.socket = socket;
    // let's track bound subscription so that they can be discarded in case of socket disconnection.
    if (!socket.subscriptions) {
        socket.subscriptions = [];
        unbindAllSubscriptionOnSocketDisconnect(socket);
        socket.subscriptions.push(subscription);;
    } else if (socket.subscriptions.indexOf(subscription) == -1) {
        socket.subscriptions.push(subscription);
    }
}

function unbindAllSubscriptionOnSocketDisconnect(socket) {
    socket.on('disconnect', function () {
        // release socket instance from its subscriptions...
        var socketSubscriptions = socket.subscriptions;
        socket.subscriptions = [];
        socketSubscriptions.forEach(function (subscription) {
            subscription.debugSub('Unbound due to disconnection.');
            subscription.socket = null;
        });
        // then give a change to reuse the subscription if the client reconnects fast enough, otherwise unsubscribe all subscriptions from this socket.
        setTimeout(function () {
            socketSubscriptions.forEach(function (subscription) {
                // if there is a socket it would be a new one, not the one is disconnected.  so the subscription has been reactivated on the new socket (client reconnected)
                if (!subscription.socket) {
                    subscription.debugSub('Timeout. Discarding Subscription. No longer in use.');
                    unsubscribe(subscription.user, subscription.id);
                }
            });

        }, Subscription.maxDisconnectionTimeBeforeDroppingSubscription * 1000);
    });
}


