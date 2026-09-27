# Contractor quotes

Quotes are only comparable when every contractor quoted the same scope. Keep the scope fixed once the owner has confirmed it.

## 1. Confirm the scope {#scope}
- executor: owner
- establishes: job.scope-confirmed
- needs: job.scope

The owner confirms the written scope the case will send to every contractor.

## 2. Find licensed contractors {#find-contractors}
- executor: web
- establishes: contractors.candidates
- needs: job.scope-confirmed

List contractors for the trade who serve the site's area, with their license numbers.

## 3. Verify licenses {#verify-licenses}
- executor: web
- establishes: contractors.verified
- needs: contractors.candidates, job.license-required

Look up each license number with the licensing board and record its status.

## 4. Call for quotes {#quote-calls}
- executor: phone-agent
- establishes: quotes.received
- needs: contractors.verified, job.access-window

Ask each verified contractor for a quote on the confirmed scope.

## 5. Normalize the quotes {#normalize}
- executor: web
- establishes: quotes.normalized
- needs: quotes.received

Put every quote on the same basis: scope, materials, timeline, warranty.

## 6. Choose {#choose}
- executor: owner
- establishes: job.chosen-contractor
- needs: quotes.normalized

The owner picks a contractor from the normalized quotes.
