'strict mode';

const Promise = require('promise'),
    zlog = require('zlog'),
    _ = require('lodash');

Subscription.maxDisconnectionTimeBeforeDroppingSubscription = 20; //seconds

var logger = zlog.getLogger('zerv/sync/subscription');

module.exports = Subscription;

/**
 * 
 * Subscription Class
 * 
 * @param user: user object must include the following properties id, tenantId, display 
 * @param subscriptionId: id for this new subscription
 * @param publication: Name of the publication name
 * @param params: a map of key/value to apply to the publication
 * 
 */
function Subscription(user, subscriptionId, publication, params) {
    var additionalParams = {};
    var queue = {};
    var initialPushCompleted, onReleaseCallback;
    const thisSub = this;

    if (!(user && user.tenantId && user.id)) {
        // should never happen...but we are in the process of refactor tenantId...
        throw (new Error('Defect: tenantId or userId is null.'));
    }

    this.id = subscriptionId;

    this.userId = user.id;
    this.tenantId = user.tenantId;

    this.user = user;

    this.params = params;
    this.additionalParams = additionalParams;
    this.publication = publication;
    this.timestamp = 0;
    this.emitAllRecords = emitAllRecords;
    this.emitChanges = emitChanges;
    this.flush = flush;
    this.hasDataToEmit = hasDataToEmit;
    this.checkIfMatch = checkIfMatch;
    this.release = release;
    this.onRelease = onRelease;




    // this give an opportunity for the publication to set additional parameters that will be use during fetching.
    if (publication.init) {
        publication.init(this.tenantId, this.user, additionalParams); // should be(this.user,additionalParams,excludedParams)
    }



    //////////////


    /**
     * Retrieved data from persistence storage and push all data to the client.
     *  
     * @returns promise
     */
    function emitAllRecords() {
        // return promise;
        var sub = this;
        initialPushCompleted = false;
        debugSub(thisSub, 'Feching all data now');
        try {
            return this.publication.fn(sub.tenantId, sub.user, this.params)
                .then(function (result) {
                    var records = toArray(result);
                    records.forEach(addToQueue);
                    flush(true);
                    return; // does not return a promise here on purpose (non blocking)
                })
                .catch(function (err) {
                    // unrecoverable error... check your fetch code.
                    logger.error(err, err.stack);
                });
        } catch (err) {
            // unrecoverable error... check your fetch code.
            logger.error(err, err.stack);
        }
    }

    function hasDataToEmit() {
        return getQueueLength() !== 0;
    }

    function flush(isAllRecords) {
        var recordsToProcess = readQueue();

        if (!thisSub.socket) {
            debugSub(thisSub, 'Emit canceled. Subscription no longer bound and pending destruction.');
            return;
        }

        logSub(thisSub, 'Emitting ' + (recordsToProcess.length > 1 ? recordsToProcess.length + ' records' : '1 record') + (isAllRecords ? ' (all)' : ''));

        thisSub.timestamp = getMaxTimestamp(thisSub.timestamp, recordsToProcess);

        // submit the data, socketio will make sure that the data is received by the client
        // if there is a network failure, the client will resubscribe and get the data.
        thisSub.socket.emit('SYNC_NOW', { name: thisSub.publication.name, subscriptionId: thisSub.id, records: recordsToProcess, params: thisSub.params, diff: !isAllRecords }, function (response) {

            removeFromQueue(recordsToProcess);

            // The client acknowledged. now we are sure that the records were received.
            initialPushCompleted = true;
            // if the publication is supposed to push the data only once...release subscription
            if (thisSub.publication.once) {
                release();
            }
            // // otherwise if something was added to the queue meantime...let's process again..
            else if (hasDataToEmit()) {
                flush();
            }
        });
        return; // does not return a promise here on purpose (non blocking)
    }

    /**
     * Emit changes.
     * change items contains the record and type (REMOVAL,ADD,UPDATE)
     * 
     * Due to async nature, a notification for change might occur before the subscription has received the initial data.
     * In this scenario, the change will be queued.
     * 
     * @param <Array> of change items to push to the client subscription
     */
    function emitChanges(records, notificationType) {
        let changesToEmit = false;

        _.forEach(records, function (record) {
            if (notificationType === 'REMOVAL') {
                if (_.isFunction(record.toJSON)) {
                    // if the object has a toJSON this will mostlikely remove the remove flag that is added later.
                    record = _.assign({}, record.toJSON());
                }
                record.remove = new Date();
            }
            changesToEmit |= addToQueue(record);
        });
        // if there is more than one record currently in the queue...it means client has not gotten all the data yet. Could be due a slow or lost of connection/ async processing. but...so let's wait it finishes and avoid emitting again.
        // the emitCache function will catch up and try to empty the queue anyway.
        if (changesToEmit && initialPushCompleted && getQueueLength() === 1) {
            flush();
        }
    }

    function addToQueue(record) {
        var rev = getRecordRevision(record);
        var previous = queue[getIdValue(record.id)];
        // add to queue only if it is a version more recent
        if (!previous || getRecordRevision(previous) < rev) {
            debugSub(thisSub, 'Adding record #' + record.id + ', revision ' + rev + ' to queue');
            queue[getIdValue(record.id)] = record;
            return true;
        }
        return false;
    }

    function removeFromQueue(records) {
        records.forEach(function (record) {
            var previous = queue[getIdValue(record.id)];
            if (!previous || getRecordRevision(previous) <= getRecordRevision(record)) {
                // remove record fromo queue only except if there is already a new version more recent (Might just have been notified)
                delete queue[getIdValue(record.id)];
                //logSub(sub, 'Dropping queue to:'+readQueue().length);
            }
        });
    }

    function getIdValue(id) {
        if (!_.isObject(id)) {
            return id;
        }
        // build composite key value
        var r = _.join(_.map(id, function (value) {
            return value;
        }), '~');
        return r;

    }


    function getRecordRevision(record) {
        // what reserved field do we use as timestamp
        // if the object contains a version, let's use it...otherwise it must provide a timestamp (that is set when inserting, updating or deleting from the db)
        if (typeof record.revision !== 'undefined' && record.revision !== null) {
            return record.revision;
        }
        if (typeof record.timestamp !== 'undefined' && record.timestamp !== null) {
            return record.timestamp;
        }
        throw new Error('A revision or timestamp property is required in records to be synced');
    }

    function readQueue() {
        var r = [];
        for (var id in queue) {
            r.push(queue[id]);
        }
        //logSub(sub, 'Read subscription queue:'+r.length);
        return r;
    }

    function getQueueLength() {
        return Object.keys(queue).length;
    }


    function checkIfMatch(object) {

        // When the subscription params are checked against the object notified to sync, the object must be serialized so it contains ids, no object references. Subscription params are id based.
        var dataParams = JSON.parse(JSON.stringify(object));

        // seid
        // sds.subscribe('forecast.sync',{opportunityId:id,type:'monthly'});
        //
        // In forecast, after calculating notify FORECAST_UPDATE
        //
        // zerv.publication('forecast.sync',
        // function(tenantId,user,seidParams) {
        //   forecast.getData(seidParams.opportunitId,seidParams.type)
        // }),
        // {
        //    FORECAST_DATA:function(notifiedData,status,params){  // params should be passed
        // 
        //          forecast.getData(notifiedData.opportunitId,params.type);
        // },
        // {init:function(tenant,user, params) {
        //      params.type = null;        
        //}}

        // if additional params has a null param, the params should not be used as identityParams
        // ex a subscription might pass some params not useful such as startDate, endDate, type... which are not useful for notification.

        var identityParams = _.assign({}, this.params);
        _.forEach(this.additionalParams, function (value, p) {
            if (thisSub.additionalParams[p] === null) {
                //the object notified does NOT need to contain this value to be identified
                delete identityParams[p];
            } else {
                //otherwise the object notified would need to contain this value to be identified
                identityParams[p] = value;
            }
        });

        return checkIfIncluded(identityParams, dataParams);

        // if TASK_DATA is notified with object containing(planId:5) and subscription params were for ie: (planId:5, status:'active')
        // the subscription would run the publication.
        // return checkIfIncluded(this.params, dataParams) && checkIfIncluded(this.additionalParams, dataParams);
    }

    function checkIfIncluded(keyParams, record) {
        if (!record.id) {
            throw (new Error('Object with no id cannot be synchronized. This is a requirement.' + JSON.stringify(record)));
        }
        if (!keyParams || Object.keys(keyParams).length === 0) {
            return true
        }
        var matching = true;
        for (var param in keyParams) {
            // are other params matching the data notification?
            // ex: we might have receive a notification about taskId=20 but we are only interested about taskId=3
            if (getIdInMinObjectIfAny(record, param) !== keyParams[param]) {
                matching = false;
                break;
            }
        }
        return matching;
    }

    /**
     * find the id value based on id property name in a record.
     * Ex: the subscription params might be on opportunityId, but account object has no opportunityId but opportunity.id...so get the value there instead.
     * 
     * @param record : object to investigate
     * @param param: id name
     * 
     * @returns id 
     */
    function getIdInMinObjectIfAny(record, param) {
        var p = param.indexOf('Id');
        if (p != -1) {
            var minObject = param.substring(0, p);
            if (record[minObject]) {
                return record[minObject].id;
            }
        }
        return record[param];
    }

    function getMaxTimestamp(timestamp, records) {
        for (var r = 0; r < records.length; r++) {
            if (timestamp < getRecordRevision(records[r])) {
                timestamp = getRecordRevision(records[r]);
            }
        }
        return timestamp;
    }

    function toArray(result) {
        if (_.isArray(result)) {
            return result;
        }
        if (result !== null) {
            return [result];
        }
        return [];
    }

    /**
     * release the subscription from memory...
     * If the client were to reconnect (after a long period of network of disconnection), a new subscription would be created
     */
    function release() {
        debugSub(thisSub, 'Unsubscribed.');
        // ubound socket to this subscription if not done already (disconnect)
        if (thisSub.socket) {
            var i = thisSub.socket.subscriptions.indexOf(thisSub);
            if (i != -1) {
                thisSub.socket.subscriptions.splice(i, 1);
            }
        }
        delete thisSub.publication.subscriptions[subscriptionId];
        if (onReleaseCallback) {
            onReleaseCallback(thisSub.tenantId);
        }
    }

    function onRelease(callback) {
        onReleaseCallback = callback;
    }
}

// function findSubscriptionsUsingPublication(tenantId, publicationName) {
//     var r = [];

//     for (var id in activeSubscriptions) {
//         var subscription = activeSubscriptions[id];
//         if (subscription.publication.name === publicationName && subscription.tenantId === tenantId) {
//             r.push(subscription);
//         }
//     }
//     return r;
// }

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
            debugSub(subscription, 'Unbound due to disconnection.');
            subscription.socket = null;
        });
        // then give a change to reuse the subscription if the client reconnects fast enough, otherwise unsubscribe all subscriptions from this socket.
        setTimeout(function () {
            socketSubscriptions.forEach(function (subscription) {
                // if there is a socket it would be a new one, not the one is disconnected.  so the subscription has been reactivated on the new socket (client reconnected)
                if (!subscription.socket) {
                    debugSub(subscription, 'Timeout. Discarding Subscription. No longer in use.');
                    unsubscribe(subscription.user, subscription.id);
                }
            });

        }, Subscription.maxDisconnectionTimeBeforeDroppingSubscription * 1000);
    });
}

function logSub(subscription, text) {
    logger.info(subscription.user.display + ': Sub %b/id%b - ' + text, subscription.publication.name, subscription.id.substring(subscription.id.length - 8));
}

function debugSub(subscription, text) {
    logger.debug(subscription.user.display + ': Sub %b/id%b - ' + text, subscription.publication.name, subscription.id.substring(subscription.id.length - 8));
}

Subscription.prototype.logSub = function (text) {
    logSub(this, text);
};

Subscription.prototype.debugSub = function (text) {
    debugSub(this, text);
};