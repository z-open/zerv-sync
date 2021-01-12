'strict mode';

const _ = require('lodash');
const DEFAULT_MAX_BATCH_SIZE = 2000;

const service = {
    breath,
    // for testing
    DEFAULT_MAX_BATCH_SIZE,
    _clearBreath,
    _giveRoomForOtherAsyncFunctionsToBeAddedToEventLoop,
    _trackBreath: _.noop
};

module.exports = service;

/**
 * Breath function prevents the publications from taking over the node process when receiving large number of notifications (1000s)
 * Function relying on time such as timeout/interval functions would be impacted negativaly (unpredictable) and delayed for a substantial amount of time.
 */
let lastActivity = 0;
let maxBatch;


const breathQueue = [];
async function breath() {
    let nextBreath = _.last(breathQueue);
    
    if (!nextBreath) {
        nextBreath = {
            promise: Promise.resolve(service._trackBreath()),
            count: 0,
            queued: false
        };
        breathQueue.push(nextBreath);
    } else if (nextBreath.count >= getMaxBatch() - 1) {
        const previousBreath = nextBreath;
        nextBreath = {
            count: 0,
            queued: true, // depends on the previous one to complete
            promise: new Promise(async (resolve) => {
                // when previous breath is completed, 
                await previousBreath.promise; 
                // time to breath again
                service._giveRoomForOtherAsyncFunctionsToBeAddedToEventLoop(resolve);
            })
        };
        breathQueue.push(nextBreath);
    } else {
        if (!nextBreath.queued && Date.now() > lastActivity + 2000) {
            // no much activity (nothing in the queue), no need to count before breathing
            // console.info('no need to breath');
            nextBreath.count = 0;
        } else {
            // busy, let's count, when the maxBatch size is met, 
            // the system will free up time for the event loop to proceed other asynchronous calls
            nextBreath.count ++;
        }
    }
    lastActivity = Date.now();
    return nextBreath.promise;
}

function _giveRoomForOtherAsyncFunctionsToBeAddedToEventLoop(callback) {
    // console.info('breath now');
    setTimeout(() => {
        breathQueue.shift();
        callback(service._trackBreath());
        // console.info('Done breathing');
    }, 100);
}

function getMaxBatch() {
    if (!maxBatch) {
        maxBatch = Number(process.env.ZERV_BATCH_MAX || DEFAULT_MAX_BATCH_SIZE);
    }
    return maxBatch;
}

function _clearBreath() {
    breathQueue.length = 0;
}
