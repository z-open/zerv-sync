const zlog = require('zimit-zlog');
zlog.setRootLogger('none');

const zervCore = require('zerv-core');
const utils = require('../lib/utils');

zervCore.transport.disabled = true;// no serialization or compression.

const sync = require('../lib/zerv-sync');
let socket;
let handler, handler2;
let tenantId;
let userId;
let subscription;
let nullValue, clientGeneratedsubscription2;
let onSubscriptionConnect, onSubscriptionDisconnect;
let magazine1V1, magazine1V2, magazine1V3, magazine2V7, magazine2DeletedV8, magazine2updatedV8, magazine3V9, magazine3V10, magazine3DeletedV11, magazine4;

describe('Sync', () => {

    beforeEach(() => {
        nullValue = null;
        clientGeneratedsubscription2 = '#222';

        magazine1V1 = { id: '1', name: 'ironfix', revision: 1, type: 'fiction' };
        magazine1V2 = { id: '1', name: 'iron man', revision: 2, type: 'fiction' };
        magazine1V3 = { id: '1', name: 'IRONMAN', revision: 3, type: 'fiction' };

        magazine2V7 = { id: '2', name: 'spider man', revision: 7, type: 'fiction' };
        magazine2DeletedV8 = { id: '2', name: 'spider man', revision: 8, type: 'fiction' };
        magazine2updatedV8 = { id: '2', name: 'spider man', revision: 8, type: 'miscellanous' };

        magazine3V9 = { id: '3', name: 'Entrepreneur', revision: 9, type: 'business' };
        magazine3V10 = { id: '3', name: 'The Entrepreneur', revision: 10, type: 'business' };
        magazine3DeletedV11 = { id: '3', name: 'Entrepreneur', revision: 11, type: 'business' };

        magazine4 = { id: '4', name: 'Heroes', revision: 1, type: 'fiction' };

        tenantId = 'TID';
        userId = 'UID1234';

        /* eslint-disable no-use-before-define */
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
        spyOn(utils, 'breath').and.callThrough();

        onSubscriptionConnect = jasmine.createSpy('onSubscriptionConnect');
        onSubscriptionDisconnect = jasmine.createSpy('onSubscriptionDisconnect');

        jasmine.clock().install();
    });

    beforeEach(() => {
        sync.publish(
            'magazines',
            () => Promise.resolve([magazine1V2, magazine2V7]),
            'MAGAZINE_DATA',
            {onSubscriptionConnect, onSubscriptionDisconnect}
        );
    });

    afterEach(() => {
        utils._clearBreath();

        // release all subsriptions
        sync.unpublish('magazines');
        jasmine.clock().uninstall();
    });

    it('should subscribe and receive the subscription id', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        expect(sync.countActiveSubscriptions()).toBe(1);
        expect(subscription).toBeDefined();
    });

    it('should execute the connect callback on subscribing', () => {
        subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines');
        expect(sync.countActiveSubscriptions()).toBe(1);
        expect(subscription).toBeDefined();
        expect(onSubscriptionConnect).toHaveBeenCalledWith(subscription);
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

        expect(onSubscriptionConnect).toHaveBeenCalledTimes(2);
        expect(onSubscriptionConnect.calls.argsFor(0)).toEqual([subscription]);
        expect(onSubscriptionConnect.calls.argsFor(1)).toEqual([subscription2]);
    });

    it('should dropActiveSubscriptions all active subscriptions from memory', () => {
        const sub1 = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        const sub2 = sync.subscribe(handler2.user, handler2.socket, clientGeneratedsubscription2, 'magazines', null);
        sync.dropActiveSubscriptions();
        expect(sync.countActiveSubscriptions()).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);
        expect(handler.socket.subscriptions.length).toBe(0);

        expect(onSubscriptionDisconnect).toHaveBeenCalledTimes(2);
        expect(onSubscriptionDisconnect.calls.argsFor(0)).toEqual([sub1]);
        expect(onSubscriptionDisconnect.calls.argsFor(1)).toEqual([sub2]);
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

        expect(onSubscriptionDisconnect).toHaveBeenCalledTimes(1);
        expect(onSubscriptionDisconnect).toHaveBeenCalledWith(subscription);
    });

    describe('network loss recovery', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
            socket.simulateDisconnect();
        });

        it('should unbound subscription to socket on disconnect but not release the subscription right away', () => {
            // it is not released right away because the client might restablish the connection and avoid pulling data from db again.
            expect(sync.countActiveSubscriptions()).toBe(1);

            expect(onSubscriptionDisconnect).toHaveBeenCalledWith(subscription);
        });

        it('should unbound subscription to socket on disconnect and release the subscription later on', () => {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500);
            expect(sync.countActiveSubscriptions()).toBe(1);
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 500 + 10);
            expect(sync.countActiveSubscriptions()).toBe(0);
            // disconnect was called during disconnect, it was not called again during the release.
            expect(onSubscriptionDisconnect).toHaveBeenCalledTimes(1);
        });

        it('should reconnect to the same subscription instance when the network re-establishes quickly', () => {
            expect(onSubscriptionConnect).toHaveBeenCalledTimes(1);
            const newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).toEqual(subscription);

            expect(onSubscriptionConnect).toHaveBeenCalledTimes(2);
            expect(onSubscriptionConnect.calls.argsFor(0)).toEqual([subscription]);
            expect(onSubscriptionConnect.calls.argsFor(1)).toEqual([subscription]);
        });

        it('should reconnect to a new subscription instance when the network does NOT re-establish quickly', () => {
            jasmine.clock().tick(sync.getMaxDisconnectionTimeBeforeDroppingSubscription() * 1000 + 10);
            const newSubscription = sync.subscribe(handler.user, handler.socket, subscription.id, 'magazines', null);
            expect(newSubscription).not.toBe(subscription);

            expect(onSubscriptionConnect).toHaveBeenCalledTimes(2);
            expect(onSubscriptionConnect.calls.argsFor(0)).toEqual([subscription]);
            expect(onSubscriptionConnect.calls.argsFor(1)).toEqual([newSubscription]);
        });

    });

    describe('initialization', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });

        it('should subscribe and receive subscription data', async () => {
            const sub = await waitForReceivingSubscribedData();
            expect(sub.records.length).toBe(2);
            expect(sub.records[0].name).toBe(magazine1V2.name);
            expect(sub.records[1].name).toBe(magazine2V7.name);
        });

        it('should subscribe and receive all data (not a diff)', async () => {
            const sub = await waitForReceivingSubscribedData();
            expect(sub.diff).toBe(false);
        });

        it('should emit only once the data at subscription initialization', async () => {
            await waitForReceivingSubscribedData();
            expect(socket.emit.calls.count()).toBe(1);
        });

    });

    describe('without subscription params', () => {

        beforeEach(() => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', null);
        });

        it('should receive an update', async () => {
            await waitForReceivingSubscribedData();
            // the client has the data
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(2);

            const resultPromise = sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1V3);
      
            const sub2 = await waitForReceivingSubscribedData();
            // 
            expect(utils.breath).toHaveBeenCalledTimes(1);
            expect(sub2.diff).toBe(true);
            expect(sub2.records.length).toBe(1);
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(3);
            expect(await resultPromise).toEqual(1);
        });

        it('should receive an addition',  async () => {
            await waitForReceivingSubscribedData();
            // the client does not have the data
            expect(subscription.getSyncedRecordVersion(magazine3V9.id)).toBeUndefined();
            expect(socket.emit.calls.count()).toBe(1);

            const resultPromise = sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3V9);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.diff).toBe(true);
            expect(sub2.records.length).toBe(1);
            expect(subscription.getSyncedRecordVersion(magazine3V9.id)).toBe(9);
            expect(await resultPromise).toEqual(1);

        });

        it('should receive a removal', async () => {
            await waitForReceivingSubscribedData();
            // the client has the data
            expect(subscription.getSyncedRecordVersion(magazine2DeletedV8.id)).toBe(7);

            const resultPromise = sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2DeletedV8);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.diff).toBe(true);
            expect(sub2.records.length).toBe(1);
            expect(subscription.getSyncedRecordVersion(magazine2DeletedV8.id)).toBeUndefined();
            expect(sub2.records[0].revision>8).toBeTrue();
            expect(sub2.records[0].revision<9).toBeTrue();
            expect(await resultPromise).toEqual(1);
        });

        it('should receive an update after a removal', async () => {
            await waitForReceivingSubscribedData();
            // the client has the data
            expect(subscription.getSyncedRecordVersion(magazine2V7.id)).toBe(7);
                
            // server does keep track of what is on the client
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2V7);
            const sub2 = await waitForReceivingSubscribedData();

            expect(sub2.diff).toBe(true);
            expect(sub2.records.length).toBe(1);
            expect(sub2.records[0].id).toBe(magazine2V7.id);
            expect(sub2.records[0].revision>7).toBeTrue();
            expect(sub2.records[0].revision<8).toBeTrue();
            // if there is a consecutive update (or even concurrent), the deleted will not interfer
            //
            // this cover the following issue on concurrent removal and update
            // server 1 notifies a removal of record rev 1, which is automatically increased to 1.01
            // server 2 notifies an update of the same record revision at the same time which is increased to 2
            // Expectation:
            // clients are guaranteed to receive notification sends by server 2 at least,
            // Some might also receive the removal but it would only remove, then sync to readd due to the update
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updatedV8);
            const sub3 = await waitForReceivingSubscribedData();

            expect(sub3.diff).toBe(true);
            expect(sub3.records.length).toBe(1);
            expect(sub3.records[0].id).toBe(magazine2V7.id);
            expect(sub3.records[0].revision).toBe(8);
        });

        it('should receive an update after a removal EVEN THOUGH the revision was not increased', async () => {
            await waitForReceivingSubscribedData();
            // the client has the data
            expect(subscription.getSyncedRecordVersion(magazine2DeletedV8.id)).toBe(7);
                
            // server does keep track of what is on the client
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2DeletedV8);
            await waitForReceivingSubscribedData();

            // ex:
            // 2 servers executed an operation on the same object of the same revision
            // one notified a remove
            // one notified an update
            //
            // in this case, client gets removal first then the update which would re-add the deleted record
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updatedV8);
            const sub3 = await waitForReceivingSubscribedData();

            expect(sub3.diff).toBe(true);
            expect(sub3.records.length).toBe(1);
            expect(sub3.records[0].id).toBe(magazine2V7.id);
            expect(sub3.records[0].revision).toBe(8);
        });

        it('should receive a removal after an update EVEN THOUGH the revision was not increased', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updatedV8);
            await waitForReceivingSubscribedData();
            // server does keep track of what is on the client
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2DeletedV8);

            // ex:
            // 2 servers executed an operation on the same object of the same revision
            // one notified an update
            // one notified a remove
            //
            // in this case, client gets update first then the removal
            const sub3 = await waitForReceivingSubscribedData();
            expect(sub3.diff).toBe(true);

            expect(subscription.getSyncedRecordVersion(magazine2DeletedV8.id)).toBeUndefined();
            expect(sub3.records[0].revision>8).toBeTrue();
            expect(sub3.records[0].revision<9).toBeTrue();
        });

        it('should attempt breathing (freeing eventloop) for each notification', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2V7);
            await waitForReceivingSubscribedData();
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updatedV8);
            await waitForReceivingSubscribedData();
            sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3V9);
            await waitForReceivingSubscribedData();
            expect(utils.breath).toHaveBeenCalledTimes(3);
        });

    });

    describe('with subscription params', () => {
        let deferredEmitChanges;

        beforeEach(() => {
            // the param is the type fiction here.
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', { type: 'fiction' });
            const emitChanges = subscription.emitChanges;
            deferredEmitChanges = defer();
            spyOn(subscription, 'emitChanges').and.callFake((...params) => {
                const result = emitChanges(...params);
                deferredEmitChanges.resolve(result);
                return result;
            });
        });

        it('should receive the data after initialization of the subscription', async () => {
            await waitForReceivingSubscribedData();
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should receive an update', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1V3);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.records.length).toBe(1);
            expect(socket.emit.calls.count()).toBe(2);
        });

        it('should receive an addition', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine4);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.records.length).toBe(1);
            expect(socket.emit.calls.count()).toBe(2);
        });

        it('should receive a removal', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine2DeletedV8);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.records.length).toBe(1);
            expect(socket.emit.calls.count()).toBe(2);
        });

        it('should receive a removal for an update notification since the record does no longer matches the subscription', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine2updatedV8);
            const sub2 = await waitForReceivingSubscribedData();
            expect(sub2.records.length).toBe(1);
            expect(socket.emit.calls.count()).toBe(2);
        });

        it('should NOT notified the addition of an object unrelated to subscription', async () => {
            await waitForReceivingSubscribedData();
            const result = await sync.notifyCreation(tenantId, 'MAGAZINE_DATA', magazine3V9);
            expect(result).toEqual(0);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notified the update of an object unrelated to subscription', async () => {
            await waitForReceivingSubscribedData();
            const result = await sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine3V10);
            expect(result).toEqual(0);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notified the removal of an object unrelated to subscription', async () => {
            await waitForReceivingSubscribedData();
            sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine3V10);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notify a revision refresh of an object unrelated to subscription', async () => {
            await waitForReceivingSubscribedData();
            const hasRecordsToEmit = await sync.notifyRefresh(tenantId, 'MAGAZINE_DATA', magazine3V10);
            expect(socket.emit.calls.count()).toBe(1);
            expect(hasRecordsToEmit).toBe(0);
        });

        it('should NOT notify a revision update of an object that was already emitted', async () => {
            await waitForReceivingSubscribedData();
            // Let's notify what was already sent during subscription initialization
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1V2);
            const hasRecordsToEmit = await deferredEmitChanges.promise;
            expect(hasRecordsToEmit).toBe(0);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notify the removal unrelated to subscription', async () => {
            await waitForReceivingSubscribedData();
            await sync.notifyDelete(tenantId, 'MAGAZINE_DATA', magazine3DeletedV11);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notify a revision refresh of an object that was already emitted', async () => {
            await waitForReceivingSubscribedData();
            // Let's notify what was already sent during subscription initialization
            sync.notifyRefresh(tenantId, 'MAGAZINE_DATA', magazine1V2);
            const hasRecordsToEmit = await deferredEmitChanges.promise;
            expect(hasRecordsToEmit).toBe(0);
            expect(socket.emit.calls.count()).toBe(1);
        });

        it('should NOT notify a revision refresh of an object that has an older version', async () => {
            await waitForReceivingSubscribedData();
            // Let's notify what was already sent during subscription initialization
            sync.notifyRefresh(tenantId, 'MAGAZINE_DATA', magazine1V1);
            const hasRecordsToEmit = await deferredEmitChanges.promise;
            expect(hasRecordsToEmit).toBe(0);
            expect(socket.emit.calls.count()).toBe(1);
        });

    });

    describe('with subscription params and filter', () => {
        let restrictedType;
        let deferredEmitChanges;
        let filter;

        beforeEach(() => {
            filter = jasmine.createSpy('publicationFilter').and.callFake(
                async (magazine, subscriptionParams, user, tenantId) => {
                    // notice the filter depends on external variable restrictedType
                    if(magazine.type === restrictedType) {
                        return null;
                    }
                    return false;
                }
            );

            const filterOptions = {
                'MAGAZINE_DATA': { filter }
            };
            sync.publish(
                'restrictedMagazines',
                () => Promise.resolve([magazine1V2, magazine2V7, magazine3V9]),
                filterOptions
            );

            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'restrictedMagazines', { type: 'fiction' });

            const emitChanges = subscription.emitChanges;

            deferredEmitChanges = defer();
            spyOn(subscription, 'emitChanges').and.callFake((...params) => {
                const result = emitChanges(...params);
                deferredEmitChanges.resolve(result);
                return result;
            });
        });

        it('should receive an update because the magazine matches the restricted filter', async () => {
            restrictedType = 'fiction';
            await waitForReceivingSubscribedData();
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(2);
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1V3);
            const sub2 = await waitForReceivingSubscribedData();
            expect(filter).toHaveBeenCalledWith(
                magazine1V3,
                { type: 'fiction' },
                handler.user,
                tenantId
            );
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(3);
            expect(sub2.records.length).toBe(1);
        });

        it('should receive a removal for the update because the magazine does not match the restricted filter any more', async () => {
            restrictedType = 'cooking';
            await waitForReceivingSubscribedData();
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(2);
            sync.notifyUpdate(tenantId, 'MAGAZINE_DATA', magazine1V3);
            const sub2 = await waitForReceivingSubscribedData();
            expect(subscription.getSyncedRecordVersion(magazine1V3.id)).toBeUndefined();
            expect(sub2.records.length).toBe(1);
        });

        it('should receive a removal for the refresh (no revision increase) because the magazine does not match the restricted filter any more', async () => {
            restrictedType = 'cooking';
            await waitForReceivingSubscribedData();
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBe(2);
            // refresh let the publications know to recompute their filter
            sync.notifyRefresh(tenantId, 'MAGAZINE_DATA', magazine1V2);
            const sub2 = await waitForReceivingSubscribedData();
            expect(subscription.getSyncedRecordVersion(magazine1V2.id)).toBeUndefined();
            expect(sub2.records.length).toBe(1);
        });

        afterEach(() => {
            sync.unpublish('restrictedMagazines');
        });
    });
        

    describe('checkIfMatch', () => {

        it('should exclude records with unmatched params (subs.setParams)', async () => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', { type: 'fiction' });
            expect(await subscription.checkIfMatch({ id: 'muId' }, 'MAGAZINE_DATA')).toEqual(false);
        });

        it('should always match records with params cacheLevel', async () => {
            subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'magazines', { cacheLevel: 0 });
            expect(await subscription.checkIfMatch({ id: 'muId' }, 'MAGAZINE_DATA')).toEqual(true);
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
                expect(await subscription.checkIfMatch(magazine1V2, 'MAGAZINE_DATA')).toEqual(true);
            });

            it('should match the object with the custom filter; however object does not match the subscription params so that it can NOT be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'business' });
                // magazin1 does have 'man' in its name but is not a business book
                expect(await subscription.checkIfMatch(magazine1V2, 'MAGAZINE_DATA')).toEqual(false);
            });

            it('should NOT match the object with the custom filter. Though object matches the subscription params, it can NOT be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'fiction' });
                // magazin4 does not have 'man' in its name
                expect(await subscription.checkIfMatch(magazine4, 'MAGAZINE_DATA')).toEqual(false);
            });

            it('should NOT match the object with the custom filter. Whether object matches the subscription params, it will not be sent to the subscription', async () => {
                subscription = sync.subscribe(handler.user, handler.socket, nullValue, 'filteredMagazines', { type: 'fiction' });
                // magazin3 does not have 'man' in its name
                expect(await subscription.checkIfMatch(magazine3V9, 'MAGAZINE_DATA')).toEqual(false);
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
                                if (magazine.name.indexOf('man') !== -1) {
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
                expect(await subscription.checkIfMatch(magazine1V2, 'MAGAZINE_DATA')).toEqual(true);
            });

        });

    });


    function waitForReceivingSubscribedData() {
        return socket.deferredEmit.promise.then((data) => {
            socket.deferredEmit = defer();
            data.acknowledge();
            return data.sub;
        });
    }

    class MockSocket {

        constructor() {
            this.deferredEmit = defer();
        }

        on(event, callback) {
            console.log('Socket.on:' + event);
            this.disconnect = callback;
        }

        emit(event, params, callback) {
            console.log('Socket.emit:' + event + '->' + JSON.stringify(params));
            this.deferredEmit.resolve({ sub: params, acknowledge: callback });

        };

        simulateDisconnect() {
            this.disconnect && this.disconnect();
        }
    }

    function defer() {
        const deferred = {};
        deferred.promise = new Promise((resolve) => {
            deferred.resolve = resolve;
        });
        return deferred;
    }
});
