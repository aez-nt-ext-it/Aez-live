import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parse} from 'csv-parse/sync';
import {openDb,migrate} from '../server/db.js';

// Import exported files only. No live Google Sheets dependency is introduced.
const [kind,file]=process.argv.slice(2);
if(!['roster-emp','roster-teach','emp-daily','teach-daily','leaves','classes'].includes(kind)||!file)throw new Error('Usage: npm run import -- roster-emp|roster-teach|emp-daily|teach-daily|leaves|classes file.csv');
const raw=await readFile(file,'utf8');
const records=parse(raw,{bom:true,skip_empty_lines:true,relax_column_count:true});
const db=await openDb();await migrate(db);
try {
  let count=0;
  await db.transaction(async tx=>{
    for(let i=0;i<records.length;i++){
      const row=records[i];
      if(kind.startsWith('roster-')){
        const email=(row[0]||'').trim().toLowerCase(),name=(row[1]||'').trim(),role=kind==='roster-emp'?'emp':'teach';
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){if(i===0)continue;throw new Error(`Invalid email at row ${i+1}; import rolled back.`);}
        if(!name)throw new Error(`Missing name at row ${i+1}`);
        await tx.query('INSERT INTO users(email,name,roles) VALUES($1,$2,ARRAY[$3]::text[]) ON CONFLICT(email) DO UPDATE SET name=$2,roles=(SELECT array_agg(DISTINCT r) FROM unnest(users.roles || ARRAY[$3]::text[]) r)',[email,name,role]);
        await tx.query('INSERT INTO profiles(email,role) VALUES($1,$2) ON CONFLICT DO NOTHING',[email,role]);
      } else {
        const id=createHash('sha256').update(kind+'|'+i+'|'+JSON.stringify(row)).digest('hex');
        await tx.query('INSERT INTO imported_records(id,kind,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,kind,JSON.stringify({sourceRow:i+1,values:row})]);
      }
      count++;
    }
  });
  console.log(`Imported ${count} rows. Historical rows remain source records until reconciliation; no working hours have been inferred.`);
} finally {await db.close();}
