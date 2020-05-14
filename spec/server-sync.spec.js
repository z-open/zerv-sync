const zlog = require('zimit-zlog');
zlog.setRootLogger('none');

const zervCore = require('zerv-core');
zervCore.transport.disabled = true;// no serialization or compression.

const sync = require('../lib/zerv-sync');
const Promise = require('promise');
let socket;
let handler, handler2;
let tenantId;
let userId;
let subscription;
let deferredEmit, deferredFetch;
let nullValue, clientGeneratedsubscription2;

let magazine1, magazine1b, magazine2, magazine2Deleted, magazine2updated, magazine3, magazine3b, magazine3Deleted, magazine4;

describe('Sync', () => {
  
    beforeEach(() => {
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

    beforeEach(() => {
        sync.publish(
            'magazines',
            () => {
                deferredFetch.resolve([magazine1, magazine2]);
                return deferredFetch.promise;
            },
            'MAGAZINE_DATA');
    });

    afterEach(() => {
    // release all subsriptions
        sync.unpublish('magazines');
        jasmine.clock().uninstall();
    });

    it('should subscribe and receive the subscription id', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(1);
        expect(subscription).toBeDefined();
    });

    it('should create multiple subscriptions attached to same socket', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        const subscription2 = sync.subscribe(handler.user, handler.socket, clientGeneratedsubscription2, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(2);
        expect(subscription).not.toBe(subscription2);
        expect(handler.socket.subscriptions.length).toBe(2);
    });

    it('should create multiple subscriptions attached to different socket', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        const subscription2 = sync.subscribe(handler2.user, handler2.socket, clientGeneratedsubscription2, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(2);
        expect(subscription).not.toBe(subscription2);
        expect(handler.socket.subscriptions.length).toBe(1);
        expect(handler.socket.subscriptions.length).toBe(1);
    });

    it('should dropActiveSubscriptions all active subscriptions from memory', () => {
        sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        sync.subscribe(handler2.user, handler2.socket, clientGeneratedsubscription2, 'magazines', null);
        sync.dropActiveSubscriptions();
        expect(sync.countActiveSubscriptions()).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);
    });

    it('should return an error when the publication is unknown', () => {
        const unknownPublication = 'unknownPublication';
        try {
            sync.subscribe(handler.user, handler.socket, nullValue, unknownPublication, null);
        } catch (err) {
            expect(err.message).toEqual('Subscription to inexisting publication [' + unknownPublication + ']');
        }
    });

    it('should unsubscribe', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        expect(subscription).toBeDefined();
        sync.unsubscribe(handler.user, subscription.id);
        expect(sync.countActiveSubscriptions()).toBe(0);
    });

    describe('network loss recovery', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
            socket.simulateDisconnect();
        });

        it('should unbound subscription to socket on disconnect but not release the subscription right away', () => {
      // it is not released right away because the client might restablish the connection and avoid pulling data from db again.
            expect(sync.countActiveSubscriptions()).toBe(1);
        });

        it('should unbound subscription to socket on disconnect and release the subscription later on', () => {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500);
            expect(sync.countActiveSubscriptions()).toBe(1);
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500 + 10);
            expect(sync.countActiveSubscriptions()).toBe(0);
        });

        it('should reconnect to the same subscription instance when the network re-establishes quickly', () => {
            const newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).toEqual(subscription);
        });

        it('should reconnect to a new subscription instance when the network does NOT re-establish quickly', () => {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 1000 + 10);
            const newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).not.toBe(subscription);
        });

    });

    describe('initialization', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });

        it('should subscribe and receive subscription data', (done) => {
            waitForNotification().then((sub) => {
                expect(sub.records.length).toBe(2);
                expect(sub.records[0].name).toBe(magazine1.name);
                expect(sub.records[1].name).toBe(magazine2.name);
                done();
            });
        });

        it('should subscribe and receive all data (not a diff)', (done) => {
            waitForNotification().then((sub) => {
                expect(sub.diff).toBe(false);
                done();
            });
        });

        it('should emit only once the data at subscription initialization', (done) => {
            deferredFetch.promise
          .then(() => {
              expect(socket.emit.calls.count()).toBe(1);
              done();
          });
        });

    });

    describe('without subscription params', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });

        it('should receive an update', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1b);
                waitForNotification().then((sub2) => {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive an addition', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3);
                waitForNotification().then((sub2) => {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2Deleted);
                waitForNotification().then((sub2) => {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal EVEN THOUGH the revision was not increased', (done) => {
            const currentTime = Date.now();
            waitForNotification().then((sub1) => {
        // server does keep track of what is on the client
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2);
                waitForNotification().then((sub2) => {
                    expect(sub2.diff).toBe(true);
                    expect(sub2.records.length).toBe(1);
                    const expectedRevision = 7 + Math.trunc(currentTime /100)/Math.pow(10, 11);
                    expect(sub2.records[0].revision).toBe(expectedRevision);
          // if there is a consecutive update (or even concurrent), the deleted will not interfer
          //
          // this cover the following issue on concurrent removal and update
          // server 1 notifies a removal of record rev 1, which is automatically increased to 1.01
          // server 2 notifies an update of the same record revision at the same time which is increased to 2
          // Expectation:
          // clients are guaranteed to receive notification sends by server 2 at least,
          // Some might also receive the removal but it would only remove, then sync to readd due to the update
                    sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1b);
                    waitForNotification().then((sub2) => {
                        expect(sub2.diff).toBe(true);
                        expect(sub2.records.length).toBe(1);
                        done();
                    });
                });
            });
        });

    });

    describe('with subscription params', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', {type: 'fiction'});
        });

        it('should receive an update', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1b);
                waitForNotification().then((sub2) => {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive an addition', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine4);
                waitForNotification().then((sub2) => {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2Deleted);
                waitForNotification().then((sub2) => {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should receive a removal for an update notification since the record does no longer matches the subscription', (done) => {
            waitForNotification().then((sub1) => {
                sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updated);
                waitForNotification().then((sub2) => {
                    expect(sub2.records.length).toBe(1);
                    done();
                });
            });
        });

        it('should NOT notified the addition unrelated to subscription', (done) => {
            deferredFetch.promise
          .then(() => {
              expect(socket.emit.calls.count()).toBe(1);
          })
          .then(waitForNotification)
          .then((sub1) => {
              sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3);
              expect(socket.emit.calls.count()).toBe(1);
              done();
          });
        });

        it('should NOT notified the update unrelated to subscription', (done) => {
            deferredFetch.promise
          .then(() => {
              expect(socket.emit.calls.count()).toBe(1);
          })
          .then(waitForNotification)
          .then((sub1) => {
              sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine3b);
              expect(socket.emit.calls.count()).toBe(1);
              done();
          });
        });

        it('should NOT notified the removal unrelated to subscription', (done) => {
            deferredFetch.promise
          .then(() => {
              expect(socket.emit.calls.count()).toBe(1);
          })
          .then(waitForNotification)
          .then((sub1) => {
              sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine3Deleted);
              expect(socket.emit.calls.count()).toBe(1);
              done();
          });
        });

    });

    describe('checkIfMatch', () => {

        it('should exclude records with unmatched params (subs.setParams)', async () => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', { type: 'fiction' });
            expect(await subscription.checkIfMatch({id: 'muId'}, 'MAGAZINE_DATA')).toEqual(false);
        });

        it('should always match records with params cacheLevel', async () => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', { cacheLevel: 0 });
            expect(await subscription.checkIfMatch({id: 'muId'}, 'MAGAZINE_DATA')).toEqual(true);
        });

        describe('with pre custom filter', () => {

            beforeEach(() => {
                sync.publish(
                    'filteredMagazines',
                    () => {
                        return [];
                    },
                    {
                        MAGAZINE_DATA: {
                            filter: (magazine, subscriptionParams, user, tenantId) => {
                                if (magazine.name.indexOf('man') !== -1) {
                                    return null;
                                }
                                return false;
                            }
                        }
                    }
                );
            });

            it('should match the object with the custom filter and subscription params so that it can be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'fiction' });
        // magazin1 does have 'man' in its name and is a fiction book
                expect(await subscription.checkIfMatch(magazine1, 'MAGAZINE_DATA')).toEqual(true);
            });

            it('should match the object with the custom filter; however object does not match the subscription params so that it can NOT be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'business' });
        // magazin1 does have 'man' in its name but is not a business book
                expect(await subscription.checkIfMatch(magazine1, 'MAGAZINE_DATA')).toEqual(false);
            });

            it('should NOT match the object with the custom filter. Though object matches the subscription params, it can NOT be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'fiction' });
        // magazin4 does not have 'man' in its name
                expect(await subscription.checkIfMatch(magazine4, 'MAGAZINE_DATA')).toEqual(false);
            });

            it('should NOT match the object with the custom filter. Whether object matches the subscription params, it will not be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'fiction' });
        // magazin3 does not have 'man' in its name
                expect(await subscription.checkIfMatch(magazine3, 'MAGAZINE_DATA')).toEqual(false);
            });

        });

        describe('with custom filter replacing default', () => {

            beforeEach(() => {
                sync.publish(
                    'filteredMagazines',
                    () => {
                        return [];
                    },
                    {
                        MAGAZINE_DATA: {
                            filter: (magazine, subscriptionParams, user, tenantId) => {
                                if (magazine.name.indexOf('man')!==-1) {
                                    return true;
                                }
                                return false;
                            }
                        }
                    }
                );
            });

            it('should match the object with the custom filter without considering the subscription params; Object would then be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'business' });
                expect(await subscription.checkIfMatch(magazine1, 'MAGAZINE_DATA')).toEqual(true);
            });

        });

    });


    function waitForNotification() {
        return deferredEmit.promise.then((data) => {
            deferredEmit = defer();
            data.acknowledge();
            return data.sub;
        });
    }

    function MockSocket() {
        let disconnect;

        this.on = (event, callback) => {
            console.log('Socket.on:' + event);
            disconnect = callback;
        };

        this.emit = (event, params, callback) => {
            console.log('Socket.emit:' + event + '->' + JSON.stringify(params));
            deferredEmit.resolve({sub: params, acknowledge: callback});
        };
        this.simulateDisconnect = () => {
            disconnect && disconnect();
        };
    }

    function defer() {
        const deferred = {};
        deferred.promise = new Promise((resolve) => {
            deferred.resolve = resolve;
        });
        return deferred;
    }
});
