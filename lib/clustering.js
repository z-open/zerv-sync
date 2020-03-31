/**
 *
 * If you run multiple zerv based application server instances (ex load balancing), all zerv instances must inter-communicate via a redis server.
 *
 * Install a redis server and provide the following node environment variables to each instance:
 *
 *    REDIS_ENABLED=true
 *    REDIS_HOST=<redis server ip or dns>
 *    REDIS_PORT=<redis server port>
 *
 *
 * The redis server must be reacheable from your instances.
 *
 * TESTING:
 * --------
 * start the zerv based app on different port and check that data is kept in sync via the server console log.
 *
 * URGENT TODO:
 * ------------
 * When zerv loses connection to redis, we might consider that the instance in no healthy since it does no longer receive any notification.
 *
 * The idea is to flag zerv has unhealthy, so that the health check returns negatively to the load balancer.
 * THe load balancer would no longer connect user to that instance.
 * Then we could kick out the current user which would automatically relogged to  a different instance and set up an alarm to the admin.
 *
 *
 * Zerv uses https://github.com/luin/ioredis that supports sentinel.
 *
 * Currently:
 * We run a redis server on aws.
 * Installation procedure
 * - create linux instance with node
 * - install redis
 * - To run as a daemon with no password and reacheable not only locally
 *    src/redis-server --protected-mode no --daemonize yes
 *
 * failsafe
 * --------
 * To implement a failsafe strategy in redis, you must run it in sentinel mode so that you can run a master with multiple slaves.
 * however currently, zerv does not accept multiple redis servers in its environment configs (to be implemented)
 *
 * Load balancing
 * --------------
 * To run redis in a cluster, install demonyte (from netflix) on each redit instance. This will allow have multiple masters replicating and handle load balancing. The zerv app would just need to know the ip of some redis servers (in different racks)
 * To install demonyte, careful to do the steps mentioned in build.sh
 * https://github.com/Netflix/dynomite/wiki
 *
 *
 *
 *
 *
 */

const
    _ = require('lodash'),
    zlog = require('zlog4js'),
    UUID = require('uuid'),
    IoRedis = require('ioredis');

UUID.generate = UUID.v4;

const logger = zlog.getLogger('zerv/sync/cluster');
const SYNC_CHANNEL_PREFIX = 'ZERV_SYNC_TENANT';
module.exports = syncWithRedis;

function syncWithRedis(processRecordNotifications, transport) {
    if (process.env.REDIS_ENABLED !== 'true') {
        return null;
    }

    const zervId = UUID.generate();


    const connectionParams = {
        port: process.env.REDIS_PORT || 6379, // Redis port
        host: process.env.REDIS_HOST || '127.0.0.1', // ec2-34-229-172-76.compute-1.amazonaws.com',//127.0.0.1',   // Redis host
    //  family: 4,           // 4 (IPv4) or 6 (IPv6)
    // password: 'auth',
    // db: 0
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

    logger.debug('listen to main cluster channel');
    redis.subscribe(getMainChannel(), function(err) {
        if (err) {
            throw new Error(err);
        }
    });

    const notificationListenerPromises = {};

    const cluster = {
        instanceId: zervId,
        broadcast: notifyCluster,
        listenToTenantNotification,
        releaseTenantNotificationListener

    };
    return cluster;

    function onError(error) {
        logger.error('Redis Connection error', JSON.stringify(error));
    };


    function onMessage(channel, message) {
        const json = transport.deserialize(message);// JSON.parse(message);
        if (!json) {
            return;
        }
        if (json.zervId !== zervId) {
            logger.debug('Received cluster sync notification on channel %b', channel);
            processRecordNotifications(json.tenantId, json.dataNotification, json.notificationType, json.objects, json.options);
        }
    }

  /**
     *
     * @param {uid} tenantId
     * @returns {Promise} that resolves when the listener is ready to receive data from the cluster
     */
    function listenToTenantNotification(tenantId) {
        const promise = notificationListenerPromises[tenantId];
        if (promise) {
            return promise;
        }
    // notificationListenerCounts[tenantId] = true;
        logger.debug('listen to cluster notifications to tenant %b', tenantId);
        return notificationListenerPromises[tenantId] = redis.subscribe(getChannelByTenantId(tenantId), function(err, count) {
      // if err, should terminate, we can't run disconnected
            if (err) {
                logger.error('Subscription error not handled properly !!! %b %b', err, count);
            }
        });
    }

    function releaseTenantNotificationListener(tenantId) {
        delete notificationListenerPromises[tenantId];
        logger.debug('Stop listening to cluster notifications to tenant %b', tenantId);
        redis.unsubscribe(getChannelByTenantId(tenantId), function(err) {
      // if err, should terminate, we can't run disconnected
            if (err) {
                logger.error('Subscription error %b %b', err);
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
     * @param {String} notificationType:  UPDATE/CREATE/REMOVAL
     * @param {Array} objects: Object/Record to notify to listening publication
     * @param {Object} options:
     *      @property allServers set to true to notify all servers. By default false, only servers handling the notified tenants received the data.
     */
    function notifyCluster(tenantId, dataNotification, notificationType, objects, options) {
        const notificationObj = {
            zervId, tenantId, dataNotification, notificationType, objects, options
        };
        if (_.get(options, 'allServers') === true) {
      // broadcast to all servers connected to redis
            pub.publish(getMainChannel(), transport.serialize(notificationObj));
        } else {
      // broadcast to the servers connected to redis and listening to a specific tenant
            pub.publish(getChannelByTenantId(tenantId), transport.serialize(notificationObj));
        }
    }

  /**
     * channel name is also based on then environment
     * to prevent conflicts is redis server is used by different environments (not recommended but practical for testing)
     * @param {*} tenantId
     */
    function getChannelByTenantId(tenantId) {
        return process.env.NODE_ENV + '_' + SYNC_CHANNEL_PREFIX + '_' + tenantId;
    }

    function getMainChannel() {
        return process.env.NODE_ENV + '_' + SYNC_CHANNEL_PREFIX + '_main';
    }
}
