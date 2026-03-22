// @ts-nocheck
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { request } = require('../helpers');
const createNodesRouter = require('../../routes/nodes');

function createTestApp(execMock) {
  const app = express();
  app.use(express.json());

  const monitor = {
    getAllStatus: () => [{ id: 'n1', online: true }],
    getNodeStatus: (id) => id === 'n1' ? { id: 'n1', online: true } : null,
  };

  const sshManager = {
    exec: execMock,
  };

  const nodesConfig = [
    { id: 'n1', name: 'TestNode', tunAddr: '10.0.0.1', status: 'approved' }
  ];

  const store = {
    findById: (id) => {
      if (id === 'n1') return { id: 'n1', skills: [{ id: 'old-skill' }] };
      return null;
    },
    update: () => {}
  };

  const keyManager = {
    store,
    updateNodeSkills: (nodeId, skills) => {
      keyManager.lastUpdatedSkills = skills;
      return { success: true };
    },
    lastUpdatedSkills: null
  };

  app.use('/api/nodes', createNodesRouter(monitor, sshManager, nodesConfig, keyManager));
  return { app, keyManager };
}

describe('Node Skills API', () => {

  describe('POST /api/nodes/:id/skills', () => {
    it('should generate curl command for HTTP source and update skills on success', async () => {
      let executedCmd = '';
      const execMock = async (node, cmd) => {
        executedCmd = cmd;
        return { code: 0, stdout: 'ok', stderr: '' };
      };
      
      const { app, keyManager } = createTestApp(execMock);

      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: {
          skillId: 'test-skill',
          name: 'Test Skill',
          source: 'https://example.com/install.sh',
          version: '1.0.0'
        }
      });

      assert.equal(res.statusCode, 200);
      assert.equal(executedCmd, 'curl -sSL https://example.com/install.sh | sudo bash');
      
      const skills = keyManager.lastUpdatedSkills;
      assert.ok(skills);
      assert.equal(skills.length, 2);
      assert.equal(skills[1].id, 'test-skill');
      assert.equal(skills[1].name, 'Test Skill');
    });

    it('should generate npm install command for NPM source', async () => {
      let executedCmd = '';
      const execMock = async (node, cmd) => {
        executedCmd = cmd;
        return { code: 0, stdout: 'ok', stderr: '' };
      };
      
      const { app } = createTestApp(execMock);

      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: {
          skillId: 'npm-package',
          source: 'npm'
        }
      });

      assert.equal(res.statusCode, 200);
      assert.equal(executedCmd, 'sudo npm install -g npm-package');
    });

    it('should return 400 for unsupported source', async () => {
      const { app } = createTestApp(async () => ({ code: 0 }));
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: {
          skillId: 'bad',
          source: 'ftp'
        }
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 500 if ssh execution fails', async () => {
      const execMock = async () => ({ code: 1, stdout: '', stderr: 'failed' });
      const { app, keyManager } = createTestApp(execMock);

      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: {
          skillId: 'npm-package',
          source: 'npm'
        }
      });

      assert.equal(res.statusCode, 500);
      assert.equal(keyManager.lastUpdatedSkills, null);
      assert.ok(res.body.error.includes('安装执行败'));
    });
  });

  describe('DELETE /api/nodes/:id/skills/:skillId', () => {
    it('should execute npm uninstall and remove from skills list', async () => {
      let executedCmd = '';
      const execMock = async (node, cmd) => {
        executedCmd = cmd;
        return { code: 0, stdout: 'uninstalled', stderr: '' };
      };
      
      const { app, keyManager } = createTestApp(execMock);

      const res = await request(app, 'DELETE', '/api/nodes/n1/skills/old-skill', {});

      assert.equal(res.statusCode, 200);
      assert.ok(executedCmd.includes('sudo npm uninstall -g old-skill'));
      
      const skills = keyManager.lastUpdatedSkills;
      assert.ok(skills);
      assert.equal(skills.length, 0); // old-skill removed
    });

    it('should reject invalid skill IDs', async () => {
      const { app } = createTestApp(async () => ({ code: 0 }));
      const res = await request(app, 'DELETE', '/api/nodes/n1/skills/bad;rm%20-rf%20/', {});
      
      assert.equal(res.statusCode, 400);
    });
  });
});
