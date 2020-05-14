const _ = require('lodash');
const zlog = require('zimit-zlog');
const zjsonbin = require('zjsonbin');
const updateService = require('../lib/update.service');
zlog.setRootLogger('none');

const zervCore = require('zerv-core');
zervCore.transport.disabled = true;// no serialization or compression.

// const sync = require('../lib/zerv-sync');
class Browser {
    constructor(id) {
        this.id = 'Browser' + id;
    }
    sendChange(data) {
        if (!this.object.stamp) {
            this.untouchedObject = _.cloneDeep(this.object);
        }
    // ui would change object
        this.object.city = data.city;
    // then it is stamped before going thru network.
        data.stamp = Date.now();
        data.timestamp = { sessionId: this.id };
        data.id = this.object.id;
        data.revision = this.object.revision;
        this.object.timestamp.sessionId = data.timestamp.sessionId;
        this.object.stamp = data.stamp;
        return data;
    }

    receive(incrementalChange) {
    // has the browser modified the object?
        if (this.object.stamp) {
            if (this.object.timestamp.sessionId === incrementalChange.timestamp.sessionId) {
        // just received a change that was made by this browser!
                this.object.revision = incrementalChange.revision;
        // nothing to increment
                if (this.object.stamp === incrementalChange.stamp) {
          // this incrementat shows that we have the same changes as the server
          // this is the reference
                    delete this.object.stamp;
                    this.untouchedObject = this.object;
                }
                return;
            } else {
        // received an increment that was not generated by this browser
        // but the browser has already made a change
        // let's roll back the browser (loses its change) to previous untouched
        // then the increment will be applied
        // (when the modification made from this browser made it to the server, it will come back update properly -> side effect, value changes back to initial value for a few seconds)
                this.object = this.untouchedObject;

                if (incrementalChange.revision > this.object.revision + 1) {
                    throw new Error('LOST_INCREMENTALS', 'Missing incrementals. This cannot be updated, we need to get full object again;');
                }
            }
        }

    // it is a valid increment, let's update the object with it
        this.object = zjsonbin.mergeChanges(this.object, incrementalChange);
        delete this.object.stamp;
        this.untouchedObject = this.object;
    }
}

class Server {
    constructor() {
        this.cache = [];
    }

    setInitial(obj) {
        this.cache = [_.cloneDeep(obj)];
    }

    updateHeaderApi(data, rejectChangeBasedOnOldData) {
        const thisServer = this;

        return updateService.process(
            data,
            fetchCurrentObjectRevision,
            saveUpdatedObject,
            {
                updateObjectData,
                handleConflict: this.handleConflict,
                fetchObjectRevision
            });

        function saveUpdatedObject(updatedObject) {
            thisServer.object = updatedObject;
            thisServer.object.revision++;
            thisServer.cache.push(_.cloneDeep(thisServer.object));
            return Promise.resolve();
        };

        function fetchCurrentObjectRevision(id) {
            return thisServer.cache[thisServer.cache.length - 1];
        }

        function fetchObjectRevision(id, revision) {
            return _.find(thisServer.cache, { revision });
        }

        function updateObjectData(objToUpdate, data) {
            if (!_.isUndefined(data.city)) {
                objToUpdate.city = data.city || null;
            }
            if (!_.isUndefined(data.zipCode)) {
                objToUpdate.zipCode = data.zipCode || null;
            }
            if (!_.isUndefined(data.phoneNumber)) {
                objToUpdate.phoneNumber = data.phoneNumber || null;
            }
        }
    }


    updateApi(incrementalChanges) {
        const fetchCurrentObjectRevision = () => this.object;
        const saveUpdatedObject = (updatedObject) => this.object = updatedObject;
    // incremental changes are merged into the current version
        return updateService.process(
            incrementalChanges,
            fetchCurrentObjectRevision,
            zjsonbin.mergeChanges,
            saveUpdatedObject
        );
    }
}

describe('Update Sync', function() {

    let browser1, browser2, server;
    let objectV1;
    let change1;

    beforeEach(function() {
        objectV1 = {
            id: 'obj1',
            city: 'Minolo',
            zipCode: null,
            revision: 1,
            timestamp: {}
        };

        change1 = {
            city: 'Maxolo'
        };

        browser1 = new Browser(1);
        browser2 = new Browser(2);
        server = new Server();
        server.setInitial(objectV1);
    });

    it('simple sync initiated and received from same browser', async (done) => {
        browser1.object = _.cloneDeep(objectV1);
        const data1 = browser1.sendChange(change1);
        const incrementalToV2 = await server.updateHeaderApi(data1);
        expect(incrementalToV2.revision).toEqual(2);
        const objectV2 = _.cloneDeep(server.object);
        expect(objectV2).toEqual({
            id: 'obj1',
            zipCode: null,
            city: change1.city,
            timestamp: {
                sessionId: browser1.id
            },
            revision: 2
        });
        browser1.receive(incrementalToV2);
        expect(browser1.object).toEqual(objectV2);
        done();
    });

    it('simple sync initiated and received from a different browser', async function(done) {
        browser1.object = _.cloneDeep(objectV1);
        browser2.object = _.cloneDeep(objectV1);
        const data1 = browser1.sendChange(change1);
        const incrementalToV2 = await server.updateHeaderApi(data1);
        const objectV2 = _.cloneDeep(server.object);
        browser2.receive(incrementalToV2);
        expect(browser2.object).toEqual(objectV2);
        done();
    });

    it('Updating a 2nd time before the receiving first sync on the same browser', async function(done) {
        const changeMadeOnV1 = {
            city: 'Maxolo2'
        };

        const differentChangeMadeOnV1 = {
            city: 'Maxolito'
        };

        server.handleConflict = handleConflictOnCityAndZipCode;

        browser1.object = _.cloneDeep(objectV1);
        const data1 = browser1.sendChange(change1);
        const incrementalToV2 = await server.updateHeaderApi(data1);

        const v1ModifiedByBrowser1 = browser1.sendChange(changeMadeOnV1);
    // the browser received the processed change, but it has already modifyied what it sent
    // browser is the author of the change, no impact. keep the new change
        browser1.receive(incrementalToV2);

        const incrementalToV3 = await server.updateHeaderApi(v1ModifiedByBrowser1);
        const objectV3 = _.cloneDeep(server.object);
        expect(objectV3).toEqual({
            id: 'obj1',
            zipCode: null,
            city: changeMadeOnV1.city,
            timestamp: {
                sessionId: browser1.id
            },
            revision: 3
        });
    // the browser received the processed change, but it is what it already has.
    // so nothing to do beside getting the new version.
        browser1.receive(incrementalToV3);
        expect(browser1.object).toEqual(objectV3);

        browser2.object = _.cloneDeep(objectV1);
    // browser2 did not issue any change and just get the new version
        browser2.receive(incrementalToV2);
    // then browser2 makes a change
        const v1ModifiedByBrowser2 = browser2.sendChange(differentChangeMadeOnV1);
    // and receive meanwhile other change
    // there is a conflict
    // if browser knows conflict management, it can keep the change
    // but here, we are going to regject
    // browser updates is current object version with all changes that are received (could be multiple)

    // browser2 should know the last valid object that has not timestamp
    // and go back to it and apply the increment to it instead of the modified

    // when differentChangeMadeOnV1 is processed by server, it will be applied on the top (if the logic says no conflict on server) -> issue is potential flash on ui, going back to old value, then showing new value
        browser2.receive(incrementalToV3);
        expect(browser2.object).toEqual(objectV3);

    // server has already processed V2 and has a V3 state
        try {
      // default conflict handling is based on revision number
            server.handleConflict = null;
            await server.updateHeaderApi(v1ModifiedByBrowser2, true);
            done.fail('Shoud conflict');
        } catch (ex) {
      // browser displays that you lost changes, because someone else modified first
            expect(ex.message).toEqual('REVISION_CONFLICT');
        }
        server.handleConflict = handleConflictOnCityAndZipCode;
    // but if server is considering not as conflict
        const incrementalToV4 = await server.updateHeaderApi(v1ModifiedByBrowser2);
        const objectV4 = server.object;

    // browser did go to V3
    // user seems to have lost it changes for a few seconds, FLASH!!!
    // but then here they appear with V4
        browser2.receive(incrementalToV4);
        expect(browser2.object).toEqual(objectV4);
        done();
    });

    it('Simulateous updates should not conflict and be merged due to valid rule', async function(done) {
        const changeMadeOnV1 = {
            zipCode: '33319'
        };

        const differentChangeMadeOnV1 = {
            phoneNumber: '954-274',
        };

        browser1.object = _.cloneDeep(objectV1);
        browser2.object = _.cloneDeep(objectV1);
        server.setInitial(objectV1);
        server.handleConflict = handleConflictOnCityAndZipCode;


        const v1ModifiedByBrowser1 = browser1.sendChange(changeMadeOnV1);
        const v1ModifiedByBrowser2 = browser2.sendChange(differentChangeMadeOnV1);
        await server.updateHeaderApi(v1ModifiedByBrowser1);
    // the change is accepted because the telephone number can be modified at the same time.
        await server.updateHeaderApi(v1ModifiedByBrowser2);
        const objectV3 = _.cloneDeep(server.object);
        expect(objectV3).toEqual({
            id: 'obj1',
            city: objectV1.city,
            zipCode: changeMadeOnV1.zipCode,
            phoneNumber: differentChangeMadeOnV1.phoneNumber,
            timestamp: { sessionId: browser2.id },
            revision: 3
        });
        done();
    });

    it('Simulateous updates should conflict due to rule', async function(done) {
        const changeMadeOnV1 = {
            zipCode: '33319'
        };

        const differentChangeMadeOnV1 = {
            city: 'Maxolo2'
        };

        browser1.object = _.cloneDeep(objectV1);
        browser2.object = _.cloneDeep(objectV1);
        server.setInitial(objectV1);
        server.handleConflict = handleConflictOnCityAndZipCode;

        const v1ModifiedByBrowser1 = browser1.sendChange(changeMadeOnV1);
        const v1ModifiedByBrowser2 = browser2.sendChange(differentChangeMadeOnV1);
        await server.updateHeaderApi(v1ModifiedByBrowser1);
        try {
      // the new city change will not be accepted because the zipcode was modified by someone else at the same time. We don't want anyone to change the city if he is not aware that the city has been changes
            await server.updateHeaderApi(v1ModifiedByBrowser2);
        } catch (ex) {
      // browser displays that you lost changes, because someone else modified first
            expect(ex.message).toEqual('RULE_CONFLICT');
        }
        done();
    });

    it('Simulateous updates should conflict due revision management rule', async function(done) {
        const changeMadeOnV1 = {
            zipCode: '33319'
        };

        const differentChangeMadeOnV1 = {
            city: 'Maxolo2'
        };

        browser1.object = _.cloneDeep(objectV1);
        browser2.object = _.cloneDeep(_.assign(
            {},
            objectV1,
            { revision: 0 }
        ));

        const v1ModifiedByBrowser1 = browser1.sendChange(changeMadeOnV1);
        const v1ModifiedByBrowser2 = browser2.sendChange(differentChangeMadeOnV1);

        await server.updateHeaderApi(v1ModifiedByBrowser1);
        try {
            await server.updateHeaderApi(v1ModifiedByBrowser2);
      // the revision was based on old object
        } catch (ex) {
      // browser displays that you lost changes, because someone else modified first
            expect(ex.message).toEqual('REVISION_CONFLICT');
        }
        done();
    });
    
});


function handleConflictOnCityAndZipCode(incrementalChange, data, previousObj, newObj) {
  // if the city was changed but the current version has also a change in the zip code, in the example, it is a conflict, otherwise if the zip was not changed, the change is accepted
    if (_.isEmpty(data.zipCode) && !_.isEmpty(data.city) && !_.isEmpty(incrementalChange.zipCode)) {
        return true;
    // reject changes
    }
  // otherwise no conflict even if the revision updated is way above the one that originated the change.
    return false;
}
