/**
 * To prevent making a call to database during subscription initialization when data was pulled earlier
 * 
 * Next: need stragegy to release cache data or limit amount
 */
const zlog = require('zlog');

var logger = zlog.getLogger('zerv/sync/cache');

module.exports = Cache;

function Cache() {
    var data = {};
    this.getData = getCachedData;
    this.update = update;
    this.reset = reset;

    function getCachedData(publication, tenantId, params) {
        // var tenantCache = cache[tenantId];
        // if (!tenantCache) {
        //     return null;
        // }
        // var pubCache = tenantCache[publication.name];
        // if (!pubCache) {
        //     return null;
        // }
        // var paramCache = _.find(pubCache, params);
        var paramCache = getParamCache(publication, tenantId, params);
        if (paramCache) {
            logger.info('Using cache data for publication %b with params %b', publication.name, params);
        }
        return paramCache ? paramCache.data : null;
    }

    function update(publication, tenantId, params, object) {
        var paramCache = getParamCache(publication, tenantId, params);
        logger.debug('Update one in publication %b with params %b', publication.name, params);
        paramCache.data.push(object);
    }

    function reset(publication, tenantId, params, objects) {
        var paramCache = getParamCache(publication, tenantId, params);
        logger.debug('Reset with new content in publication %b with params %b', publication.name, params);
        paramCache.data = objects;
        return objects;
    }

    function getParamCache(publication, tenantId, params) {
        var tenantCache = cache[tenantId];
        if (!tenantCache) {
            tenantCache = cache[tenantId] = {};
        }
        var paramCache;
        var pubCache = tenantCache[publication.name];

        if (!pubCache) {
            pubCache = tenantCache[publication.name] = [];
        } else {
            paramCache = _.find(pubCache, params);
        }

        if (!paramCache) {
            paramCache = _.assign(
                { data: [] }, params
            );
            pubCache.push(paramCache);
        }
        return paramCache;
    }
}
