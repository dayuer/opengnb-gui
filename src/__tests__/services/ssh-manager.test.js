'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const SSHManager = require('../../services/ssh-manager');

describe('SSHManager.buildAsyncWrapper', () => {
  it('生成包含 nohup + setsid 的包装脚本', () => {
    const wrapper = SSHManager.buildAsyncWrapper(
      'systemctl restart gnb',
      'abc123',
      'http://10.1.0.1:3000/api/jobs/abc123/callback',
      'token-xyz'
    );

    assert.ok(wrapper.includes('nohup'), '应包含 nohup');
    assert.ok(wrapper.includes('setsid'), '应包含 setsid');
    assert.ok(wrapper.includes('JOB_DISPATCHED:abc123'), '应有投递确认');
    assert.ok(wrapper.includes('systemctl restart gnb'), '应包含原始命令');
    assert.ok(wrapper.includes('http://10.1.0.1:3000/api/jobs/abc123/callback'), '应包含回调 URL');
    assert.ok(wrapper.includes('token-xyz'), '应包含 clawToken');
    assert.ok(wrapper.includes('base64'), '应使用 base64 编码输出');
    assert.ok(wrapper.includes('curl'), '应使用 curl 回调');
  });

  it('命令中的单引号正确转义', () => {
    const wrapper = SSHManager.buildAsyncWrapper(
      "echo 'hello world'",
      'def456',
      'http://host/callback',
      'tok'
    );
    // 单引号应被转义为 '"'"'
    assert.ok(wrapper.includes('hello'), '命令内容应保留');
    assert.ok(!wrapper.includes("'''"), '不应有连续三个单引号');
  });

  it('临时文件目录包含 jobId', () => {
    const wrapper = SSHManager.buildAsyncWrapper('ls', 'job789', 'http://h/cb', 't');
    assert.ok(wrapper.includes('/tmp/job_job789'), '临时目录应包含 jobId');
  });
});
