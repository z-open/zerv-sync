const _ = require('lodash');
const service = require('../lib/clustering');

describe('clustering service', () => {
    describe('_processMessage function', () => {
        let processRecordNotifications;
        let notifObj;
        let transport;

        beforeEach(() => {
            processRecordNotifications = jasmine.createSpy('processRecordNotifications');
            notifObj = {
                tenantId: 'tenantId',
                dataNotification: 'SOME_DATA_TYPE',
                notificationType: 'update',
                objects: {id: 'id1', name: 'John'},
                options: {param: true}
            };
            transport = {
                deserialize: (data) => _.clone(data)
            };
            spyOn(transport, 'deserialize');
        });

        it('should process the received notification', () => {
            transport.deserialize.and.callThrough();
            const result = service._processMessage(transport, 'testChannel', notifObj, processRecordNotifications );
            expect(result).toEqual(notifObj);
            expect(transport.deserialize).toHaveBeenCalledWith(notifObj);
            expect(processRecordNotifications).toHaveBeenCalledWith(
                'tenantId',
                'SOME_DATA_TYPE',
                'update',
                {id: 'id1', name: 'John'},
                {param: true}
            );
        });

        it('should not process the received notification due to transport error', () => {
            transport.deserialize.and.throwError('deserialization error');
            const result = service._processMessage(transport, 'testChannel', notifObj, processRecordNotifications );
            expect(result).toBeNull();
            expect(transport.deserialize).toHaveBeenCalledWith(notifObj);
            expect(processRecordNotifications).not.toHaveBeenCalled();
        });
    });
});
