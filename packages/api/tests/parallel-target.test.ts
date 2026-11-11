import {expect,it} from 'vitest';
import {configuredParallelism} from '../src/autopilot/feature-dev.js';
it('honors configured legacy targets without silently clamping to four',()=>{
 expect(configuredParallelism(12)).toBe(12);
 expect(configuredParallelism(undefined)).toBe(1);
 for(const value of [0,-1,1.5,NaN,Infinity])expect(()=>configuredParallelism(value)).toThrow();
});
