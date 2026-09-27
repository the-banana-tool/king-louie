# Property sale

Work through the steps in order. A step whose outputs are already facts in the case can be skipped with a Decide entry that cites them.

## 1. Confirm the parcel {#confirm-parcel}
- executor: web
- establishes: property.parcel-id, property.acreage
- needs: property.address

Search the county assessor by the property address. Cite the parcel page in sources/ and record the parcel id and the assessed acreage.

## 2. Pull the plat and the deed {#plat-and-deed}
- executor: web
- establishes: property.recorded-plat, property.deed-reference
- needs: property.parcel-id

Find the recorded plat and the most recent deed at the county recorder. The plat's acreage wins over the assessor's when they differ.

## 3. Check utilities {#utilities}
- executor: phone-agent
- establishes: property.water-available, property.sewer-available
- needs: property.parcel-id
- optional: true

Ask the utility district whether water and sewer reach the parcel and what a connection costs.

## 4. Find comparable sales {#comparables}
- executor: web
- establishes: market.comparable-sales
- needs: property.acreage

Collect sales of similar vacant parcels in the same county from the last two years, with the price per acre.

## 5. List the parcel {#list}
- executor: browser
- establishes: listing.url
- needs: property.floor-price, market.comparable-sales

Create the listing on the marketplace the owner chose. Never list below the floor price.

## 6. Reach buyers {#buyer-outreach}
- executor: phone-agent
- establishes: buyers.contacted
- needs: listing.url

Call the buyers and agents on the outreach list. Record each answer as a fact.

## 7. Review offers {#offer-review}
- executor: owner
- establishes: sale.accepted-offer
- needs: buyers.contacted

The owner reviews the offers the case has recorded and decides.
