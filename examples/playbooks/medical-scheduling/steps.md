# Specialist appointment

Share only what a step needs. The specialty is enough to book; a diagnosis or history is never needed.

## 1. Check coverage {#coverage}
- executor: web
- establishes: coverage.specialist-visits
- needs: patient.insurance-plan

Read the plan's rules for specialist visits: referral required, copay, prior authorization.

## 2. Find in-network providers {#in-network-providers}
- executor: web
- establishes: providers.candidates
- needs: appointment.specialty, patient.insurance-plan

List in-network providers for the specialty from the insurer's directory.

## 3. Confirm referral needs {#referral-needs}
- executor: phone-agent
- establishes: provider.referral-required
- needs: providers.candidates

Ask the provider's office whether they need a referral on file before booking.

## 4. Book the visit {#book}
- executor: phone-agent
- establishes: appointment.booked
- needs: appointment.window, provider.referral-required

Book the first slot inside the patient's window.

## 5. Confirm with the patient {#confirm}
- executor: owner
- establishes: appointment.confirmed
- needs: appointment.booked

The owner confirms the booking and adds it to their calendar.
