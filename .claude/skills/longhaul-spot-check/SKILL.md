---
name: longhaul-spot-check
description: Run a LongHaul judge spot-check through the chat, so the owner can review judgments from another device. Use when the owner asks to spot-check a LongHaul run, review judge verdicts, or continue a spot-check remotely.
---

# LongHaul spot-check over chat

`longhaul spot-check` is an interactive terminal prompt. This skill drives it
with piped input so the owner can review from a phone or another machine: you
show the judgments in the chat, the owner replies with verdicts, you record
them.

Arguments: `<runId> [reviewer initials]`. With no run id, list the pending
runs (step 1) and ask which one. Ask for the initials once if not given.

## Privacy

The sample quotes private session text (question, reference, reply, the
judge's reason). The owner asked to see it here, and that covers only this:

- Show the rows in the chat reply, as the CLI printed them. Nowhere else: not
  in a file, the repo, memory, a commit message, an artifact or a subagent
  prompt.
- Do not summarise, analyse or reuse the text for anything but this review.
- Run the commands yourself; never delegate them.
- Run nothing else on the same `LONGHAUL_HOME` while a `longhaul run` is
  going.

## Steps

1. **Pending count** (numbers only, no text):

   ```bash
   cd ~/.longhaul/private/spot-checks && for f in *.jsonl; do node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);console.log(process.argv[1].replace(".jsonl",""),"pending",r.filter(x=>!x.humanVerdict).length,"of",r.length)' $f; done
   ```

2. **Show the next batch** (5 items; `s` skips without recording, and the CLI
   prints one more item than the skips it reads):

   ```bash
   printf 's\ns\ns\ns\n' | node bin/longhaul.js spot-check --run <runId> --reviewer <initials> 2>&1 | grep -v 'Warning\|trace-warnings'
   ```

   Post each item as: its header line (`[n/total] adapter - kind - questionId`),
   Q, Reference, Also accept, Reply, and `Judge: <verdict> - <reason>`. Number
   them 1 to 5. Leave out the prompt lines and the final count line. Then ask
   for five verdicts in order, and say what the letters mean:

   `y` agree with the judge · `c` correct · `p` partial · `i` incorrect ·
   `a` abstained · `s` skip (stays pending)

   The owner's verdict is about the reply against the reference, not about
   whether the judge did well: `y` is the "judge got it right" key.

3. **Record the answers.** Accept forms like `y y c i y`, `yycIy`, or
   "all y". If the count is not exactly the number of items shown, or a letter
   is not one of the six, ask again; never guess a verdict. Then:

   ```bash
   printf 'y\ny\nc\ni\ny\n' | node bin/longhaul.js spot-check --run <runId> --reviewer <initials> 2>&1 | grep -v 'Warning\|trace-warnings'
   ```

   Pending rows keep their order, so the five letters land on the five items
   shown. Check it: the headers the command echoes before each prompt must be
   the same question ids, in the same order, as the batch you posted. If they
   differ, stop and tell the owner which ids were recorded.

   This command also prints the item after the batch; ignore it and take the
   next batch from step 2 again (a skipped item comes back first).

4. **Repeat** steps 2 and 3 until the last line says nothing is pending, or
   the owner says stop. Progress is saved after every verdict, so stopping is
   always safe.

5. **Finish** with the last line's numbers: reviewed, and judge agreement
   (`agreed/reviewed`). When every sampled run of a report is reviewed, offer
   to rebuild it: `node bin/longhaul.js report --runs <id>,<id>`.

## Fixing a verdict

There is no undo key. To redo one item, clear it and it comes back as
pending (this prints nothing private):

```bash
node -e 'const fs=require("fs"),p=process.argv[1],q=process.argv[2],a=process.argv[3];const r=fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(JSON.parse);let n=0;for(const x of r)if(x.questionId===q&&x.adapter===a&&x.humanVerdict){x.humanVerdict=null;x.reviewer=null;n++;}fs.writeFileSync(p,r.map(x=>JSON.stringify(x)).join("\n")+"\n");console.log("cleared",n)' ~/.longhaul/private/spot-checks/<runId>.jsonl <questionId> <adapter>
```
