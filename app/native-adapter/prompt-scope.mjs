import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,link,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const text=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u001f\u007f]/u.test(value);
const sameScope=(a,b)=>['hostId','accountScope','threadId'].every(key=>a?.[key]===b?.[key]);
const scoped=(authority,threadId)=>uuid.test(threadId??'')&&text(authority?.hostId)&&text(authority?.accountScope)
 ?{hostId:authority.hostId.trim().normalize('NFC'),accountScope:authority.accountScope.trim().normalize('NFC'),threadId}:null;
const receiptFile=(directory,turnId)=>path.join(path.resolve(directory),createHash('sha256').update(JSON.stringify(['userPromptSubmit',turnId])).digest('hex')+'.json');
const sourceValid=run=>run?.eventName==='userPromptSubmit'&&run.source==='sessionFlags'&&run.handlerType==='command'
 &&run.scope==='turn'&&Number.isSafeInteger(run.displayOrder)&&run.displayOrder>=0&&text(run.sourcePath)
 &&run.id===`user-prompt-submit:${run.displayOrder}:${run.sourcePath}`;
async function realDirectory(directory){const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new TypeError('Invalid prompt receipt directory');}
async function readReceipt(file){await realDirectory(path.dirname(file));const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw new TypeError('Invalid prompt receipt');return JSON.parse(await readFile(file,'utf8'));}

/** Receipts are written only from official backend hook/started notifications. */
export async function recordPromptScope({notification,directory,authority}={}){
 if(notification?.method!=='hook/started'||!directory)return null;
 const {threadId,turnId,run}=notification.params??{},scope=scoped(authority,threadId);
 if(!scope||!scope.hostId||!scope.accountScope||!uuid.test(turnId??'')||!sourceValid(run))return null;
 const receipt={schemaVersion:1,eventName:'userPromptSubmit',scope,turnId,source:'sessionFlags',sourcePath:run.sourcePath,observedAt:new Date().toISOString()};
 const file=receiptFile(directory,turnId);await mkdir(path.dirname(file),{recursive:true,mode:0o700});await realDirectory(path.dirname(file));
 const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;await writeFile(temporary,JSON.stringify(receipt),{flag:'wx',mode:0o600});
 try{try{await link(temporary,file);}catch(error){if(error.code!=='EEXIST')throw error;const previous=await readReceipt(file);
   if(previous.schemaVersion!==1||previous.eventName!==receipt.eventName||previous.source!==receipt.source||previous.sourcePath!==receipt.sourcePath||!sameScope(previous.scope,scope)||previous.turnId!==turnId)throw new TypeError('Ambiguous prompt scope');
   return previous;
 }}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return receipt;
}

/** Never infer a child's task from the shared parent session_id. */
export async function readPromptScope({input,directory,authority,waitMs=2000,now=Date.now}={}){
 if(input?.hook_event_name!=='UserPromptSubmit'||!uuid.test(input.agent_id??'')||!uuid.test(input.turn_id??'')||!directory)return null;
 const file=receiptFile(directory,input.turn_id),until=Date.now()+Math.min(2000,Math.max(0,Number.isFinite(waitMs)?waitMs:2000));
 while(true){try{const receipt=await readReceipt(file),scope=scoped(authority,input.agent_id),age=(typeof now==='function'?now():now)-Date.parse(receipt.observedAt);
   if(receipt.schemaVersion!==1||receipt.eventName!=='userPromptSubmit'||receipt.source!=='sessionFlags'||!text(receipt.sourcePath)||!scope||!sameScope(receipt.scope,scope)||receipt.turnId!==input.turn_id||!Number.isFinite(age)||age < -5000||age > 300000)return null;
   return receipt;
  }catch(error){if(error.code!=='ENOENT'||Date.now()>=until)return null;await delay(Math.min(40,Math.max(1,until-Date.now())));}}
}
