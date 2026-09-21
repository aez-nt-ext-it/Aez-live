import {chromium} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {openDb,migrate} from '../server/db.js';
import {createApp} from '../server/app.js';
import assert from 'node:assert/strict';

const db=await openDb('','memory://');await migrate(db);
for(let i=0;i<18;i++){
  const email=i===0?'admin@example.com':`user${i}@example.com`;
  await db.query('INSERT INTO users(email,name,roles,admin) VALUES($1,$2,$3,$4)',[email,i===0?'Test Admin':`Employee ${i}`,['emp','teach'],i===0]);
  for(const role of ['emp','teach'])await db.query('INSERT INTO profiles(email,role) VALUES($1,$2)',[email,role]);
}
let origin;
const app=createApp(db,{origin:'http://localhost:3199',verifyToken:async()=>({email:'admin@example.com',email_verified:true})});
const server=app.listen(3199,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));origin='http://localhost:3199';
const browser=await chromium.launch({channel:'msedge',headless:true});
await mkdir('test-results',{recursive:true});
try{
  const context=await browser.newContext();
  const response=await context.request.post(origin+'/api/auth/google',{headers:{Origin:origin},data:{credential:'test-only'}});
  assert.equal(response.status(),200);
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(origin);await page.locator('#controls').getByText('Login / Resume',{exact:true}).waitFor();
  await page.locator('#controls').getByText('Login / Resume',{exact:true}).click();
  await page.locator('#controls').getByText('Take a Break',{exact:true}).waitFor();
  await page.locator('#controls').getByText('Take a Break',{exact:true}).click();
  await page.locator('#controls').getByText('Resume Work',{exact:true}).waitFor();
  await page.locator('#controls').getByText('Resume Work',{exact:true}).click();
  await page.locator('#controls').getByText('Logout',{exact:true}).waitFor();
  await page.screenshot({path:'test-results/desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.locator('#reportResults tbody tr').first().waitFor();
  const downloadPromise=page.waitForEvent('download');await page.getByText('Download Excel',{exact:true}).click();
  const download=await downloadPromise;assert.equal(download.suggestedFilename(),'aez-attendance.xlsx');
  await download.saveAs('test-results/attendance.xlsx');
  await page.screenshot({path:'test-results/reports.png',fullPage:true});
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Educator',exact:true}).click();
  await page.getByRole('button',{name:'Start Class',exact:true}).click();
  await page.getByLabel('Subject').fill('Maths');await page.getByLabel('Student Name').fill('Test Student');
  await page.locator('#modalSubmitBtn').click();
  await page.getByRole('button',{name:'Class Over / Logout',exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'Educator',exact:true}).click();
  await page.getByRole('button',{name:'Class Over / Logout',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
  const last=page.locator('.dashboard-row').last();await last.scrollIntoViewIfNeeded();assert.equal(await last.isVisible(),true);
  await page.setViewportSize({width:360,height:640});await page.screenshot({path:'test-results/mobile-small.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);
  console.log('Browser checks passed: attendance, breaks, class start, persistent session, admin XLSX download, desktop/mobile.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));await db.close();}
