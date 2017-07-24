const zlog = require('zlog'),
    UUID = require('uuid'),
    IoRedis = require('ioredis');

UUID.generate = UUID.v4;

const logger = zlog.getLogger('zerv/sync/cluster');

module.exports = syncWithRedis;

IoRedis.Promise.onPossiblyUnhandledRejection(function (error) {
    logger.info('ERRRROR')
    logger.info('error:', JSON.stringify(error));
    // you can log the error here.
    // error.command.name is the command name, here is 'set'
    // error.command.args is the command arguments, here is ['foo']
});

function syncWithRedis(processRecordNotifications) {
    const zervId = UUID.generate();
    

    const connectionParams = {
        port: 6379,          // Redis port
        host: 'ec2-34-229-172-76.compute-1.amazonaws.com',//127.0.0.1',   // Redis host
        //  family: 4,           // 4 (IPv4) or 6 (IPv6)
        // password: 'auth',
        //db: 0
        // enableOfflineQueue: false, // do not buffer if there is no connection but return an error,
        // reconnectOnError:function() {
        //     logger.info('error:',arguments)
        // }
    };
    logger.info('Redis: Cache Use - host: %b - port: %b',connectionParams.host,connectionParams.port);

    const redis = new IoRedis(connectionParams);
    redis.on('error', function (error) {
        logger.info('ERRRROR redis')
        logger.info('error:', JSON.stringify(error));
    });



    const pub = new IoRedis(connectionParams);
    pub.on('error', function (error) {
        logger.info('ERRRROR pub')
        logger.info('error:', JSON.stringify(error));
    });


    redis.subscribe('ZERV_SYNC', function (err, count) {
        // if err, should terminate, we can't run disconnected
        if (err) {
            logger.error('Subscription error %b %b', err, count);
        }
    });
    redis.on('message', function (channel, message) {
        const json = JSON.parse(message);
        if (json.zervId !== zervId && channel === 'ZERV_SYNC') {
            logger.info('Received Cluster Sync notification');
            processRecordNotifications(json.tenantId, json.dataNotification, json.notificationType, json.objects, json.options);
        }
    });

    return {
        instanceId: zervId,
        broadcast: notifyCluster
    };
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
        pub.publish('ZERV_SYNC', JSON.stringify({
            zervId,
            tenantId, dataNotification, notificationType, objects, options
        }));
    }
}
