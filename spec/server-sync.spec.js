const zlog = require('zlog');
zlog.setRootLogger('none');

const zervCore = require('zerv-core');
zervCore.transport.disabled = true;// no serialization or compression.

const sync = require('../lib/zerv-sync');
let Promise = require('promise');
let socket;
let handler;
let tenantId;
let userId;
let subscription;
let deferredEmit, deferredFetch;
let nullValue, clientGeneratedsubscription2;

let magazine1, magazine1b, magazine2, magazine2Deleted, magazine2updated, magazine3, magazine3b, magazine3Deleted, magazine4;

describe('Sync', function() {
    beforeEach(function() {
        nullValue = null;
        clientGeneratedsubscription2 = '#222';

        magazine1 = {id: '1', name: 'iron man', revision: 0, type: 'fiction'};
        magazine1b = {id: '1', name: 'IRONMAN', revision: 1, type: 'fiction'};
        magazine2 = {id: '2', name: 'spider man', revision: 7, type: 'fiction'};
        magazine2Deleted = {id: '2', name: 'spider man', revision: 8, type: 'fiction'};
        magazine2updated = {id: '2', name: 'spider man', revision: 8, type: 'miscellanous'};
        magazine3 = {id: '3', name: 'Entrepreneur', revision: 9, type: 'business'};
        magazine3b = {id: '3', name: 'The Entrepreneur', revision: 10, type: 'business'};
        magazine3Deleted = {id: '3', name: 'Entrepreneur', revision: 11, type: 'business'};
        magazine4 = {id: '4', name: 'Heroes', revision: 1, type: 'fiction'};

        deferredEmit = defer();
        deferredFetch = defer();

        tenantId = 'TID';
        userId = 'UID1234';

        socket = new MockSocket();

        handler = {
            user: {
                tenantId,
                id: userId,
                display: 'John'
            },
            socket: socket
        };

        handler2 = {
            user: {
                tenantId,
                id: 'U2',
                display: 'Mike'
            },
            socket: new MockSocket()
        };

        spyOn(socket, 'emit').and.callThrough();

        jasmine.clock().install();
    });

    beforeEach(function() {
        sync.publish(
            'magazines',
            function() {
                deferredFetch.resolve([magazine1, magazine2]);
                return deferredFetch.promise;
            },
            'MAGAZINE_DATA');
    });

    afterEach(function() {
        // release all subsriptions
        sync.dropActiveSubscriptions();
        jasmine.clock().uninstall();
    });

    it('should subscribe and receive the subscription id', function() {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(1);
        expect(subscription).toBeDefined();
    });

    it('should create multiple subscriptions attached to same socket', function() {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        let subscription2 = sync.subscribe(handler.user, handler.socket, clientGeneratedsubscription2, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(2);
        expect(subscription).not.toBe(subscription2);
        expect(handler.socket.subscriptions.length).toBe(2);
    });

    it('should create multiple subscriptions attached to different socket', function() {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        let subscription2 = sync.subscribe(handler2.user, handler2.socket, clientGeneratedsubscription2, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(2);
        expect(subscription).not.toBe(subscription2);
        expect(handler.socket.subscriptions.length).toBe(1);
        expect(handler.socket.subscriptions.length).toBe(1);
    });

    it('should dropActiveSubscriptions all active subscriptions from memory', function() {
        sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        sync.subscribe(handler2.user, handler2.socket, clientGeneratedsubscription2, 'magazines', null);
        sync.dropActiveSubscriptions();
        expect(sync.countActiveSubscriptions()).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);
    });

    it('should return an error when the publication is unknown', function() {
        let unknownPublication = 'unknownPublication';
        try {
            sync.subscribe(handler.user, handler.socket, nullValue, unknownPublication, null);
        } catch (err) {
            expect(err.message).toEqual('Subscription to inexisting publication [' + unknownPublication + ']');
        }
    });

    it('should unsubscribe', function() {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        expect(subscription).toBeDefined();
        sync.unsubscribe(handler.user, subscription.id);
        expect(sync.countActiveSubscriptions()).toBe(0);
    });

    describe('network loss recovery', function() {
        beforeEach(function() {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
            socket.simulateDisconnect();
        });

        it('should unbound subscription to socket on disconnect but not release the subscription right away', function() {
            // it is not released right away because the client might restablish the connection and avoid pulling data from db again.
            expect(sync.countActiveSubscriptions()).toBe(1);
        });

        it('should unbound subscription to socket on disconnect and release the subscription later on', function() {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500);
            expect(sync.countActiveSubscriptions()).toBe(1);
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500 + 10);
            expect(sync.countActiveSubscriptions()).toBe(0);
        });

        it('should reconnect to the same subscription instance when the network re-establishes quickly', function() {
            let newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).toEqual(subscription);
        });

        it('should reconnect to a new subscription instance when the network does NOT re-establish quickly', function() {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 1000 + 10);
            let newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).not.toBe(subscription);
        });
    });

    describe('initialization', function() {
        beforeEach(function() {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });

        it('should subscribe and receive subscription data', function(done) {
            waitForNotification().then(function(sub) {
                expect(sub.records.length).toBe(2);
                expect(sub.records[0].name).toBe(magazine1.name);
                expect(sub.records[1].name).toBe(magazine2.name);
                done();
            });
        });

        it('should subscribe and receive all data (not a diff)', function(done) {
            waitForNotification().then(function(sub) {
                expect(sub.diff).toBe(false);
                done();
            });
        });

        it('should emit only once the data at subscription initialization', function(done) {
            deferredFetch.promise
                .then(function() {
                    expect(socket.emit.calls.count()).toBe(1);
                    done();
                });
        });
    });

    describe('without subscription params', function() {
        beforeEach(function() {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });
        it('should receive an update', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1b);
                waitForNotification().then(function(sub2) {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive an addition', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3);
                waitForNotification().then(function(sub2) {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2Deleted);
                waitForNotification().then(function(sub2) {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should NOT receive a removal if the revision was not increased', function(done) {
            waitForNotification().then(function(sub1) {
                // server does keep track of what is on the client
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2);
                waitForNotification().then(function(sub2) {
                    fail('Should have not notified any data to subscription');
                });
                done();
            });
        });
    });

    describe('with subscription params', function() {
        beforeEach(function() {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', {type: 'fiction'});
        });

        it('should receive an update', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1b);
                waitForNotification().then(function(sub2) {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive an addition', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine4);
                waitForNotification().then(function(sub2) {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2Deleted);
                waitForNotification().then(function(sub2) {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal for an update notification since the record does no longer matches the subscription', function(done) {
            waitForNotification().then(function(sub1) {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updated);
                waitForNotification().then(function(sub2) {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should NOT notified the addition unrelated to subscription', function(done) {
            deferredFetch.promise
                .then(function() {
                    expect(socket.emit.calls.count()).toBe(1);
                })
                .then(waitForNotification)
                .then(function(sub1) {
                    sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3);
                    expect(socket.emit.calls.count()).toBe(1);
                    done();
                });
        });

        it('should NOT notified the update unrelated to subscription', function(done) {
            deferredFetch.promise
                .then(function() {
                    expect(socket.emit.calls.count()).toBe(1);
                })
                .then(waitForNotification)
                .then(function(sub1) {
                    sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine3b);
                    expect(socket.emit.calls.count()).toBe(1);
                    done();
                });
        });


        it('should NOT notified the removal unrelated to subscription', function(done) {
            deferredFetch.promise
                .then(function() {
                    expect(socket.emit.calls.count()).toBe(1);
                })
                .then(waitForNotification)
                .then(function(sub1) {
                    sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine3Deleted);
                    expect(socket.emit.calls.count()).toBe(1);
                    done();
                });
        });
    });


    // it("returns status code 200", function (done) {
    //     done();
    // });
    // describe("GET /", function () {
    //     it("returns status code 200", function (done) {
    //         request.get(base_url, function (error, response, body) {
    //             expect(response.statusCode).toBe(200);
    //             done();
    //         });
    //     });

    //     it("returns Hello World", function (done) {
    //         request.get(base_url, function (error, response, body) {
    //             expect(body).toBe("Hello World");
    //             done();
    //         });
    //     });
    // });

    function waitForNotification() {
        return deferredEmit.promise.then(function(data) {
            deferredEmit = defer();
            data.acknowledge();
            return data.sub;
        });
    }

    function MockSocket() {
        let disconnect;

        this.on = function(event, callback) {
            console.log('Socket.on:' + event);
            disconnect = callback;
        };

        this.emit = function(event, params, callback) {
            console.log('Socket.emit:' + event + '->' + JSON.stringify(params));
            deferredEmit.resolve({sub: params, acknowledge: callback});
        };
        this.simulateDisconnect = function() {
            disconnect && disconnect();
        };
    }

    function defer() {
        let deferred = {};
        deferred.promise = new Promise(function(resolve, reject) {
            deferred.resolve = resolve;
        });
        return deferred;
    }
});
