import { describe, expect, it } from 'vitest';
import { userBinDirs, withUserBinPath } from '../src/user-path.js';

describe('withUserBinPath', () => {
  it('appends user bin dirs to the minimal PATH a GUI launch inherits', () => {
    const env = withUserBinPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, { home: '/Users/t', platform: 'darwin' });
    const path = (env.PATH ?? '').split(':');
    expect(path.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    expect(path).toContain('/Users/t/.local/bin');
    expect(path).toContain('/opt/homebrew/bin');
  });

  it('keeps existing order and does not duplicate dirs already present', () => {
    const start = ['/Users/t/.local/bin', ...userBinDirs('/Users/t').slice(1), '/usr/bin'].join(':');
    const env = withUserBinPath({ PATH: start }, { home: '/Users/t', platform: 'darwin' });
    expect(env.PATH).toBe(start);
  });

  it('handles a missing PATH and leaves other variables alone', () => {
    const env = withUserBinPath({ HOME: '/Users/t' }, { home: '/Users/t', platform: 'linux' });
    expect(env.HOME).toBe('/Users/t');
    expect(env.PATH?.split(':')[0]).toBe('/Users/t/.local/bin');
  });

  it('is a no-op on Windows', () => {
    const input = { PATH: 'C:\\Windows' };
    expect(withUserBinPath(input, { platform: 'win32' })).toBe(input);
  });
});
