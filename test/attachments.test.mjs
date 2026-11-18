import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAttachmentFiles } from '../dist/attachments.js';

test('both API paths share bounded credential-safe attachment reading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'h1-attachment-safety-'));
 try {
  const proof=join(dir,'proof.png');await writeFile(proof,Buffer.from([137,80,78,71]));
  const files=await readAttachmentFiles([proof]);assert.equal(files[0].name,'proof.png');assert.deepEqual(files[0].bytes,Buffer.from([137,80,78,71]));
  await assert.rejects(readAttachmentFiles([]),/1–16/);
  const secret=join(dir,'.env');await writeFile(secret,'SYNTHETIC_TEST_VALUE=not-a-secret');
  await assert.rejects(readAttachmentFiles([secret]),/credential\/secret/);
  const link=join(dir,'innocent-proof.txt');await symlink(secret,link);
  await assert.rejects(readAttachmentFiles([link]),/credential\/secret/);
  await assert.rejects(readAttachmentFiles([dir]),/not a regular file/);
  const large=join(dir,'large.txt');await writeFile(large,'');await truncate(large,26*1024*1024);
  await assert.rejects(readAttachmentFiles([large]),/25MB/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
