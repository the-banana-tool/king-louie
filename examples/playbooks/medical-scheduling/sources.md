All URLs in this file are placeholders on example.com; replace them with the patient's insurer and local providers.

Health warning: everything found through these sources is health information. Record it with category health; it then stays out of other cases and out of outbound payloads unless the owner makes it disclosable.

## Insurer provider directory

- Record kinds: in-network providers by specialty and location, plan rules.
- Query shape: filter by plan, specialty and distance from the patient's area.
- Example: https://insurer.example.com/directory?specialty=SPECIALTY

## Provider office

- Record kinds: new-patient availability, referral requirements.
- Query shape: ask for the first new-patient slot in the window; ask whether a referral must be on file.
- Example: https://clinic.example.com/new-patients
