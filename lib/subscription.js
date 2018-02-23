'strict mode';

const Promise = require('promise'),
    zlog = require('zlog4js'),
    _ = require('lodash');

Subscription.maxDisconnectionTimeBeforeDroppingSubscription = 20; // seconds

const logger = zlog.getLogger('zerv/sync/subscription');

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
    const additionalParams = {};
    const queue = {};
    let clientStates = {};
    let initialPushCompleted, onReleaseCallback;
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


    // ////////////


    /**
     * Retrieved data from persistence storage and push all data to the client.
     *
     * @returns promise
     */
    function emitAllRecords() {
        initialPushCompleted = false;
        isDebug() && debugSub(thisSub, 'Feching all data now');
        try {
            return fetchAllData()
                .then(function(result) {
                    let records = toArray(result);
                    records.forEach(addToQueue);
                    flush(true);
                    return; // does not return a promise here on purpose (non blocking)
                })
                .catch(function(err) {
                    // unrecoverable error... check your fetch code.
                    logError(thisSub, 'Fetch failure.', err);
                });
        } catch (err) {
            // unrecoverable error... check your fetch code.
            logError(thisSub, 'Fetch failure.', err);
        }
    }

    function fetchAllData() {
        const r = thisSub.publication.fn(thisSub.tenantId, thisSub.user, thisSub.params);
        return thisSub.publication.fn.then ? r : Promise.resolve(r);
    }

    function hasDataToEmit() {
        return getQueueLength() !== 0;
    }

    function flush(isAllRecords) {
        if (isAllRecords) {
            // a change of strategy later on, could be to send ALSO to the client all the client state records as removal if there are not present in the queue. but this could have side effect...
            clientStates = {};
        }
        const recordsToProcess = readQueue();

        if (!thisSub.socket) {
            isDebug() && debugSub(thisSub, 'Emit canceled. Subscription no longer bound and pending destruction.');
            return;
        }

        // logSub(thisSub, 'Emitting ' + (recordsToProcess.length > 1 ? recordsToProcess.length + ' records' : '1 record') + (isAllRecords ? ' (all)' : ''));

        thisSub.timestamp = getMaxTimestamp(thisSub.timestamp, recordsToProcess);

        const notificationObj = {name: thisSub.publication.name, subscriptionId: thisSub.id, records: recordsToProcess, params: thisSub.params, diff: !isAllRecords};
        logSub(thisSub,
            'Emitting ' + (recordsToProcess.length > 1 ? recordsToProcess.length + ' records' : '1 record') + (isAllRecords ? ' (all)' : ''));

        thisSub.socket.emit('SYNC_NOW', thisSub.transport.disabled ? notificationObj : thisSub.transport.serialize(notificationObj), function(response) {
            // The client acknowledged. now we are sure that the records were received.
            removeFromQueue(recordsToProcess);
            addToCache(recordsToProcess);

            initialPushCompleted = true;
            // if the publication is supposed to push the data only once...release subscription
            if (thisSub.publication.once) {
                release();
            // otherwise if something was added to the queue meantime...let's process again..
            } else if (hasDataToEmit()) {
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
    function emitChanges(notifications) {
        let changesToEmit = false;
        const isQueueEmpty = !getQueueLength();
        _.forEach(notifications, (notification) => {
            const record = notification.type === 'REMOVAL' ? buildLightRecordForRemoval(notification.record) : notification.record;
            changesToEmit |= addToQueue(record);
        });
        // if there is more than one record currently in the queue...it means client has not gotten all the data yet. Could be due a slow or lost of connection/ async processing. but...so let's wait it finishes and avoid emitting again.
        // the emitCache function will catch up and try to empty the queue anyway.
        if (changesToEmit && initialPushCompleted && isQueueEmpty) {
            flush();
        }
    }


    /**
     * The record to be send for removal syncing does NOT need to contain all data
     * Client only cares to know that it is removed.
     *
     * @param {*} record
     * @returns {Object} light version of the record with removal flags
     *
     */
    function buildLightRecordForRemoval(record) {
        return {
            id: getIdValue(record.id),
            // we do not need to increase the revision number from the outside for removal
            // this cover the following issue on concurrent removal and update
            // server 1 notifies a removal of record rev 1, which is automatically increased to 1.01
            // server 2 notifies an update of the same record revision at the same time which is increased to 2
            // Expectation:
            // clients are guaranteed to receive notification sends by server 2 at least,
            // Some might also receive the removal but it would only remove, then sync to readd due to the update
            //
            revision: getRecordRevision(record) + 0.01,
            timestamp: {remove: new Date()},
            remove: new Date() // should remove in the zerv-ng-sync, and use the timestamp!!
        };
    }

    function addToQueue(record) {
        const recordId = getIdValue(record.id);
        const revisionToEmit = getRecordRevision(record);
        const clientStateVersion = clientStates[recordId];

        if (!_.isNil(clientStateVersion) && clientStateVersion >= revisionToEmit) {
            // the client has already acknowledged to have this record or greater revision
            // don't send it again
            return false;
        }

        const queuedRecord = queue[recordId];
        // prevent sending a removal for a record
        // when it is not in clientStates and queue
        if (_.isNil(clientStateVersion) && !queuedRecord && record.remove) {
            // the client does not care about the record removal, it does not have it.
            // So don't send it
            return false;
        }
        // add to queue only if it is a version more recent
        if (queuedRecord && getRecordRevision(queuedRecord) >= revisionToEmit) {
            // a more recent record is already in the queue about to reach the client
            // so don't send this old one
            return false;
        }

        isDebug() && debugSub(thisSub, 'Adding record #' + record.id + ', revision ' + revisionToEmit + (record.remove?' for removal notif' : '') + ' to queue');
        queue[recordId] = record;
        return true;
    }

    function removeFromQueue(records) {
        records.forEach(function(record) {
            const recordId = getIdValue(record.id);
            const previous = queue[recordId];
            if (!previous || getRecordRevision(previous) <= getRecordRevision(record)) {
                // remove record fromo queue only except if there is already a new version more recent (Might just have been notified)
                delete queue[recordId];
                // logSub(sub, 'Dropping queue to:'+readQueue().length);
            }
        });
    }

    function addToCache(records) {
        records.forEach(function(record) {
            const recordRev = getRecordRevision(record);
            const recordId = getIdValue(record.id);
            const clientStateRevision = clientStates[recordId];
            if ((!clientStateRevision || clientStateRevision < recordRev) && !record.remove) {
                // keep track of which records client has
                isDebug() && debugSub(thisSub, 'Adding record #' + recordId + ', revision ' + recordRev + ' to clientStates');
                clientStates[recordId] = recordRev;
            }
        });
        isDebug() && debugSub(thisSub, 'Number of records expected in client: ' + Object.keys(clientStates).length);
    }

    function getIdValue(id) {
        if (!_.isObject(id)) {
            return id;
        }
        // build composite key value
        let r = _.join(_.map(id, function(value) {
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
        // let r = [];
        // _.values(qute,)
        // for (let id in queue) {

        //     r.push(queue[id]);
        // }
        // logSub(sub, 'Read subscription queue:'+r.length);
        return _.values(queue);
    }

    function getQueueLength() {
        return Object.keys(queue).length;
    }


    function checkIfMatch(object, dataNotification) {
        // When the subscription params are checked against the object notified to sync, the object must be serialized so it contains ids, no object references. Subscription params are id based.
        let dataParams = JSON.parse(JSON.stringify(object));

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
        // }}

        // if additional params has a null param, the params should not be used as identityParams
        // ex a subscription might pass some params not useful such as startDate, endDate, type... which are not useful for notification.

        let identityParams = _.assign({}, this.params);
        _.forEach(this.additionalParams, function(value, p) {
            if (thisSub.additionalParams[p] === null) {
                // the object notified does NOT need to contain this value to be identified
                delete identityParams[p];
            } else {
                // otherwise the object notified would need to contain this value to be identified
                identityParams[p] = value;
            }
        });

        const notificationFilter = publication.dataNotifications[dataNotification].filter;
        if (notificationFilter) {
            return notificationFilter(object, identityParams);
        }

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
            return true;
        }
        let matching = true;
        for (let param in keyParams) {
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
        let p = param.indexOf('Id');
        if (p != -1) {
            let minObject = param.substring(0, p);
            if (record[minObject]) {
                return record[minObject].id;
            }
        }
        return record[param];
    }

    function getMaxTimestamp(timestamp, records) {
        for (let r = 0; r < records.length; r++) {
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
        throw new Error('RECORD_NOT_FOUND');
        return [];
    }

    /**
     * release the subscription from memory...
     * If the client were to reconnect (after a long period of network of disconnection), a new subscription would be created
     */
    function release() {
        isDebug() && debugSub(thisSub, 'Unsubscribed.');
        // ubound socket to this subscription if not done already (disconnect)
        if (thisSub.socket) {
            let i = thisSub.socket.subscriptions.indexOf(thisSub);
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

function logError(subscription, text, error) {
    logger.error('%s: Sub %b/id%b - %s', subscription.user.display, subscription.publication.name, subscription.id.substring(subscription.id.length - 8), text, error.stack);
}

function logSub(subscription, text) {
    logger.info('%s: Sub %b/id%b - %s', subscription.user.display, subscription.publication.name, subscription.id.substring(subscription.id.length - 8), text);
}

function debugSub(subscription, text) {
    logger.debug('%s: Sub %b/id%b - %s', subscription.user.display, subscription.publication.name, subscription.id.substring(subscription.id.length - 8), text);
}

let isDebugLevel;
function isDebug() {
    // quick fix to improve performance. logger should have logger.canLog('DEBUG')
    if (_.isNil(isDebugLevel)) {
        let l = logger.getLevel() || 'all';
        l = l.toUpperCase();

        isDebugLevel = _.some(['ALL', 'TRACE', 'DEBUG'], (o) => l === o);
    }
    return isDebugLevel;
}


Subscription.prototype.logSub = function(text) {
    logSub(this, text);
};

Subscription.prototype.debugSub = function(text) {
    isDebug() && debugSub(this, text);
};
