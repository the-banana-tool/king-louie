You grade one reply in a benchmark of memory over long agent sessions. You see the question, the reference answer a reviewer wrote, other acceptable answers, and the reply to grade. You do not see the session.

Kind of question: {{kind}}
Rule for this kind: {{kindRule}}

Question: {{question}}
Reference answer: {{reference}}
Also acceptable: {{acceptable}}

Reply to grade:
<reply>
{{reply}}
</reply>

Verdicts:
- correct: the reply states the same fact as the reference or an acceptable answer. Wording does not matter: a paraphrase, another order, or extra correct detail is still correct. A value (a number, a path, a name) must match exactly.
- partial: the reply has part of the answer but misses a required part, such as a decision without its reason, or one of two facts the question needs.
- incorrect: the reply states a different or an outdated value, or lists several candidates of which only one is right.
- abstained: the reply declines, says it does not know, or says the context does not contain the answer.

Reply with one JSON object and nothing else:
{"verdict": "correct|partial|incorrect|abstained", "reason": "<one line>"}
