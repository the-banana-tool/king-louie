You write one question for a benchmark that tests memory over a long agent session.

The question will be asked at message #{{askAtSeq}}, in place of the owner's message there. It must be answerable only from the messages below, which all come before #{{askAtSeq}}.

Kind: {{kind}}
Rule for this kind: {{kindRule}}

Constraints:
- evidenceSeqs lists the message numbers (the # numbers in the headers below) that hold the answer. Use only messages shown below.
- Ask about one specific fact: a value, a name, a path, a count, or a decision and its reason. Never ask about something that can only be guessed.
- Keep the answer short. acceptableAnswers lists other short strings that are also correct.
- Phrase the question the way the owner would ask it later, without quoting the messages.
- For kind abstain: ask about something plausible for this session that is never stated in it. The answer is "not in the session" and evidenceSeqs is [].
- If the messages hold no good question of this kind, reply {"skip": "<why>"}.

Reply with one JSON object and nothing else:
{"question": "...", "answer": "...", "acceptableAnswers": ["..."], "evidenceSeqs": [123], "notes": "..."}

Messages:

{{span}}
