'strict mode';

const utils= require('../lib/utils');

describe('utils', () => {

    let breath;
    let maxBatch;
    let breaths;
    let breathCount;

    beforeEach(() => {
        maxBatch = process.env.ZERV_BATCH_MAX = 20;
        breaths = [];
        breathCount = 0;
        spyOn(utils, '_trackBreath').and.callFake(() => breathCount++);

    });

    it('should NOT need to breath when called a few times', async () => {
        for(let n = 0; n < maxBatch; n++) {
            breaths.push(utils.breath());
        } 
        for(let n = 0; n < breaths.length; n++) {
            expect(await breaths[n]).toBe(0);
        }
    });

    it('should breath when called many times', async () => {
        for(let n = 0; n < maxBatch; n++) {
            utils.breath();
        } 
        // this time it should breath
        breath = await utils.breath();
        expect(breath).toBe(1);  
    });

    it('should breath each time batch size is reached', async () => {
        for(let n = 0; n < maxBatch * 3 + 1; n++) {
            breaths.push(utils.breath());
        } 
        for(let n = 0; n < breaths.length; n++) {
            if (n< maxBatch) {
                expect(await breaths[n]).toBe(0);
            } else  if (n< maxBatch * 2) {
                expect(await breaths[n]).toBe(1);
            } else  if (n< maxBatch * 3) {
                expect(await breaths[n]).toBe(2);
            } else {
                expect(await breaths[n]).toBe(3);
            }
        }
    });

    xit('should NOT breath when last activity was sometime ago', async () => {
        jasmine.clock().install();
        try {
            for(let n = 0; n < (Number(maxBatch)) + 10; n++) {
                breaths.push(utils.breath());
            }   
            jasmine.clock().tick(1000);

            const last = utils.breath();
            jasmine.clock().tick(3000);

            expect(await last).toBeNull();
        } finally {
            jasmine.clock().uninstall();
        }
        
    });

    afterEach(() => {
        utils._clearBreath();
    });
});


