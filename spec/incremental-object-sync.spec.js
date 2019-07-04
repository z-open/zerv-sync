const _ = require('lodash');
const zlog = require('zlog4js');
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
        this.object.name = data.name;
        // then it is stamped before going thru network.
        data.stamp = Date.now();
        data.source = this.id;
        data.revision = this.object.revision;
        this.object.source = data.source;
        this.object.stamp = data.stamp;
        return data;
    }

    receive(incrementalChange) {
        // has the browser modified the object?
        if (this.object.stamp) {
            if (this.object.source === incrementalChange.source) {
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
        this.object = _.assign(this.object, incrementalChange);
        delete this.object.stamp;
        this.untouchedObject = this.object;
    }
}

class Server {
    updateHeaderApi(data, rejectChangeBasedOnOldData) {
        return this.processUpdate(
            data,
            (objToUpdate, data) => {
                objToUpdate.name = data.name;
                objToUpdate.address = data.address || null;
            },
            (incrementalChange, previousObj, newObj) => {
                if (!incrementalChange.name && incrementalChange.address) {
                    // accept change
                }
                // this change was not based on the most recent revision
                if (rejectChangeBasedOnOldData) {
                    throw new Error('CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + this.object.revision);
                }
            });
    }

    processUpdate(data, updateObject, handleConflict) {
        // api process logic
        // if (data.name)
        const newObj = _.cloneDeep(this.object);
        updateObject(newObj, data);

        // general logic to figure out the increment
        const previousObj = this.object;
        const incrementalChange = {};
        newObj.source = data.source;

        // find out which data has changed
        // we need to go deeper to find out differences
        _.forEach(_.keys(newObj), key => {
            if (!_.isEqual(newObj[key], previousObj[key])) {//} && (_.isNull(newObj[key]) !== _.isNull(previousObj[key]))) {
                incrementalChange[key] = newObj[key];
            }
        });

        if (data.revision < this.object.revision) {
            if (handleConflict(incrementalChange, previousObj, newObj)) {
                throw new Error('CONFLICT', 'This change was based on revision ' + data.revision + ' but the data was already modified and current revision is ' + this.object.revision);
            }
            // the change is accepted to merge in current revision
        }

        // find out what is to be deleted too and put in incrementChange
        //
        this.object = newObj;
        delete this.object.stamp;
        this.object.revision++;

        incrementalChange.revision = this.object.revision;
        incrementalChange.stamp = data.stamp;
        incrementalChange.source = data.source;
        return incrementalChange;
    }
}

describe('Sync', function () {
    let browser1, browser2, server;
    let objectV1;
    beforeEach(function () {
        objectV1 = {
            name: 'Minolo',
            address: null,
            revision: 1
        };


        browser1 = new Browser(1);
        browser2 = new Browser(2);
        server = new Server();
        server.object = _.cloneDeep(objectV1);
    });


    it('rebuild obj', function () {
        const change1 = {
            name: 'Maxolo'
        };
        const changeMadeOnV1 = {
            name: 'Maxolo2'
        };

        const differentChangeMadeOnV1 = {
            name: 'Maxolito'
        };

        browser1.object = _.cloneDeep(objectV1);
        let data1 = browser1.sendChange(change1);
        const incrementalToV2 = server.updateHeaderApi(data1);
        expect(incrementalToV2.revision).toEqual(2);
        const objectV2 = _.cloneDeep(server.object);
        expect(objectV2).toEqual({
            address: null,
            name: change1.name,
            source: browser1.id,
            revision: 2
        });


        let v1ModifiedByBrowser1 = browser1.sendChange(changeMadeOnV1);
        // the browser received the processed change, but it has already modifyied what it sent
        // browser is the author of the change, no impact. keep the new change
        browser1.receive(incrementalToV2);

        const incrementalToV3 = server.updateHeaderApi(v1ModifiedByBrowser1);
        const objectV3 = _.cloneDeep(server.object);
        expect(objectV3).toEqual({
            address: null,
            name: changeMadeOnV1.name,
            source: browser1.id,
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
        let v1ModifiedByBrowser2 = browser2.sendChange(differentChangeMadeOnV1);
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
        // but is it a conflict to apply this change to V3?
        // if yes,  we do not need to do anything, the client has already rollback when it received the incrementalToV3
        try {
            server.updateHeaderApi(v1ModifiedByBrowser2, true);
        } catch (ex) {
            // browser displays that you lost changes, because someone else modified first
            expect(ex.message).toEqual('CONFLICT');
        }
        // but if server is considering not as conflict
        const incrementalToV4 = server.updateHeaderApi(v1ModifiedByBrowser2);
        const objectV4 = server.object;

        // browser did go to V3
        // user seems to have lost it changes for a few seconds, FLASH!!!
        // but then here they appear with V4
        browser2.receive(incrementalToV4);
        expect(browser2.object).toEqual(objectV4);
    });
});
