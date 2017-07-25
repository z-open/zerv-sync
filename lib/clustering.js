const zlog = require('zlog'),
    UUID = require('uuid'),
    IoRedis = require('ioredis');

UUID.generate = UUID.v4;

const logger = zlog.getLogger('zerv/sync/cluster');
const SYNC_CHANNEL_PREFIX = 'ZERV_SYNC_TENANT_';
module.exports = syncWithRedis;

IoRedis.Promise.onPossiblyUnhandledRejection(function (error) {

    logger.info('error:', JSON.stringify(error));
    // you can log the error here.
    // error.command.name is the command name, here is 'set'
    // error.command.args is the command arguments, here is ['foo']
});

function syncWithRedis(processRecordNotifications) {

    if (process.env.REDIS_ENABLED !== 'true') {
        return null;
    }

    const zervId = UUID.generate();


    const connectionParams = {
        port: process.env.REDIS_PORT || 6379,          // Redis port
        host: process.env.REDIS_HOST || '127.0.0.1',//ec2-34-229-172-76.compute-1.amazonaws.com',//127.0.0.1',   // Redis host
        //  family: 4,           // 4 (IPv4) or 6 (IPv6)
        // password: 'auth',
        //db: 0
        // enableOfflineQueue: false, // do not buffer if there is no connection but return an error,
        // reconnectOnError:function() {
        //     logger.info('error:',arguments)
        // }
    };
    logger.info('Redis: Cache enabled - host: %b - port: %b', connectionParams.host, connectionParams.port);

    const redis = new IoRedis(connectionParams);
    redis.on('error', onError);
    redis.on('message', onMessage);

    const pub = new IoRedis(connectionParams);
    pub.on('error', onError);

    const notificationListenerCounts = {};

    const cluster = {
        instanceId: zervId,
        broadcast: notifyCluster,
        listenToTenantNotification,
        releaseTenantNotificationListener

    };
    return cluster;

    function onError(error) {
        logger.error('error:', JSON.stringify(error));
    };

    function onMessage(channel, message) {
        const json = JSON.parse(message);
        if (json.zervId !== zervId) {
            logger.info('Received Cluster Sync notification');
            processRecordNotifications(json.tenantId, json.dataNotification, json.notificationType, json.objects, json.options);
        }
    }

    function listenToTenantNotification(tenantId) {
        const count = notificationListenerCounts[tenantId];
        if (!count) {
            notificationListenerCounts[tenantId] = 1;
            redis.subscribe(SYNC_CHANNEL_PREFIX + tenantId, function (err, count) {
                // if err, should terminate, we can't run disconnected
                if (err) {
                    logger.error('Subscription error %b %b', err, count);
                }
            });
        } else {
            notificationListenerCounts[tenantId] = count + 1;
        }
    }

    function releaseTenantNotificationListener(tenantId) {
        const count = notificationListenerCounts[tenantId];
        notificationListenerCounts[tenantId] = --count;
        redis.unsubscribe(SYNC_CHANNEL_PREFIX + tenantId, function (err) {
            // if err, should terminate, we can't run disconnected
            if (err) {
                logger.error('Subscription error %b %b', err, count);
            }
        });
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
    function notifyCluster(tenantId, dataNotification, notificationType, objects, options) {
        pub.publish(SYNC_CHANNEL_PREFIX + tenantId, JSON.stringify({
            zervId, tenantId, dataNotification, notificationType, objects, options
        }));
    }
}
