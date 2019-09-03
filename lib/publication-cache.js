'strict mode';
const zjsonBin = require('zjsonbin');

/**
 *
 * This cache is necessary to compute the incremental changes.
 *
 * It keeps the version in memory of the data sent over to a subscription.
 * Then when data needs to be pushed over to the subscription,
 * the subscription does have access to the last synced revision
 * to calculate the next increment.
 *
 * it also keeps the increment in cache to prevent its recalculation.
 * 
 * Cache auto cleans itself
 *
 * Note this consumes server resources, so it is recommended to active the incremental functionality only on publication that published large amount of data and whose data is often modified.
 */
class PublicationCache {
    constructor(publication) {
        this.tenantCache = {};
    }

    add(tenantId, record, revision) {
        let recordCache = this.get(tenantId, record.id);
        if (!recordCache) {
            recordCache = new IncrementalRecordCache();
            this.tenantCache[tenantId + '[' + record.id] = recordCache;
        }
        recordCache.cacheRecord(record, revision);
        return recordCache;
    }

    get(tenantId, recordId) {
        return this.tenantCache[tenantId + '[' + recordId];
    }
}

class IncrementalRecordCache {
    constructor() {
        this.revisions = {};
        this.increments = {};
    }

    cacheRecord(record, revision) {
        if (this.revisions[revision]) {
            // already cached. no need to jsonify
            return;
        }
        this.revisions[revision] = zjsonBin.jsonify(record);
    }

    getRecordByRevision(revision) {
        return this.revisions[revision];
    }

    // the increment depends on the subscription params.
    cacheIncrement(subscription, data, fromRevision, toRevision) {
        this.increments[fromRevision + '[' + toRevision] = data;
    }

    getIncrementFromRevisionToRevision(subscription, fromRevision, toRevision) {
        return this.increments[fromRevision + '[' + toRevision];
    }
}
module.exports = PublicationCache;

