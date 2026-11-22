# Ortaq — Project Documentation

> **Repository:** [github.com/rentify-kz/ortaq-osi](https://github.com/rentify-kz/ortaq-osi)
> **Setup and launch instructions:** see [README.md](README.md)

---

## 1. Product

**Ortaq** is a management platform for condominium owners' associations (ОСИ) in Kazakhstan. It connects resident requests, maintenance work, building finances and owners' voting in one system, and produces official reports and meeting protocols from the same data.

| Part | Who uses it | Platform |
|---|---|---|
| Web workspace | ОСИ chairman, accountant, platform admin | Browser |
| Mobile app | Residents (owners and tenants), building staff | iOS / Android (Expo) |

---

## 2. Target Audience and Problem

### Target audience

- **ОСИ chairmen** — run the building, often alone and without a background in accounting or law.
- **Accountants** — keep the ledger and prepare the monthly report.
- **Residents** — apartment owners and tenants who pay fees and want to know what happens with them.
- **Building staff** — plumbers, electricians, cleaners and yard keepers who carry out the work.

### Problem statement

| Who | Problem today |
|---|---|
| Residents | Don't see where their monthly fees go; requests get lost in WhatsApp chats; no way to check that work was actually done |
| Chairmen | Reports in the government form, debt tracking and work assignment are done by hand in spreadsheets and chats |
| Owners' meetings | Rarely reach quorum and are easy to dispute in court: notice deadlines, quorum by area and voter identification are checked by hand, if at all |

Since **3 August 2026**, electronic voting on housing matters is legal in Kazakhstan — on condition that every owner is identified. Ortaq is built around this: identity and every ballot are confirmed with an **ЭЦП (digital signature)** through eGov mobile.

---

## 3. Implemented Features

All five phases of the roadmap are complete.

### Platform and security
- Platform admin panel: organizations, houses and unit generation
- Chairman accounts with mandatory two-factor authentication (TOTP)
- Re-confirmation with a code before sensitive actions (money, votes, reports)
- **House isolation in three layers:** route scope, automatic query scoping, PostgreSQL row-level security
- Tamper-evident **audit log** with a hash chain

### Residents and onboarding
- Sign-in by SMS code; joining a house by invite link or join request
- **Identity verification with ЭЦП**, matched against the owner registry uploaded by the chairman
- Owner registry and unit areas import
- Announcements with read statistics; notifications with quiet hours

### Requests and tasks
- Requests with photos and location; triage by the chairman; duplicate merging
- Tasks assigned to staff, with before/after photo reports and chairman approval
- Recurring tasks (e.g. weekly yard cleaning)

### Finances
- Ledger on the **official chart of accounts** (Order №163, Appendix 3, as amended in 2025); posted entries cannot be changed
- Tariffs per m² or fixed, **automatic monthly charges**
- **Kaspi payment** by link and receipt upload, with forgery checks: duplicate files, re-photographed receipts, reused transaction numbers, wrong amount or recipient
- Payment confirmation by the chairman only
- Finance dashboard — the same figures for residents and the board; debtors list visible to the board only
- **Monthly report** in the government form: drafted automatically on the 15th, completeness check, ЭЦП signatures, publication to residents

### Voting
- Required majority **derived automatically** from the decision type (simple majority or 2/3)
- **5-day notice rule** enforced by the server and the database
- **Owner register frozen** at the start; votes weighted by unit area, quorum above 50% of the area
- Ballots **signed with ЭЦП** and verified on the server; ballots cannot be edited or deleted
- Written survey (Art. 43): paper ballots entered with a mandatory scan, marked in the protocol
- Automatic reminders to non-voters; automatic closing at the deadline
- **Protocol generated automatically**, signed by the chairman and the secretary, published to residents, kept for 5 years

### AI layer (Gemini)
- Request triage and a step-by-step plan for the chairman; nothing changes without a person's decision
- **Tasks from voice notes**: speech recognition (Russian with Kazakh words), tasks split by specialization, confirmed by the chairman
- **Comparison of contractor quotes** (PDF): price, term, warranty, prepayment, hidden costs, a recommendation and warnings
- **Legal assistant** answering only from the Housing Relations Law with verbatim, verified quotes; says so when there is no basis
- **Weekly summary** for residents from house aggregates; receipt photo recognition
- Personal data (names, ИИН, phones, flat numbers) is removed before any call; per-house limits; the system works without the model

### Documents and localization
- PDF of the monthly report, the annual report and meeting protocols; Excel export of the journal, reports and debtors
- Russian and Kazakh interface in the web workspace and the mobile app

---

## 4. Technologies Used

| Layer | Technology |
|---|---|
| Backend | NestJS 11, TypeScript, Prisma 6 |
| Database | PostgreSQL 16 with row-level security, triggers for immutable records |
| Web | React 19, Vite, Tailwind CSS 4, TanStack Query, React Router |
| Mobile | Expo SDK 58, React Native, Expo Router |
| Validation | zod 4 schemas shared by server and clients |
| Monorepo | pnpm workspaces, Turborepo |
| Testing | Vitest, Supertest — 340 tests against a real database |
| Local services | Docker Compose: PostgreSQL, Mailpit, SeaweedFS (S3-compatible storage) |
| AI | Gemini API (structured JSON output), pgvector for the legal corpus |
| Documents | pdfkit (PDF), pdf.js (reading quotes), ExcelJS |
| Integrations (planned) | SIGEX / eGov mobile (ЭЦП), Kaspi, SMS gateway, push |

---

## 5. Known Limitations

| Area | Limitation |
|---|---|
| Integrations | SIGEX/eGov signing, SMS, push and Kaspi run as development stand-ins; real adapters need contracts with the providers |
| AI | Voice notes are sent to Gemini as audio (it cannot be redacted); scanned quotes without a text layer are not read |
| File security | PDF malware check is heuristic in development; production refuses PDFs until a real scanner is connected |
| Documents | The annual report is built on demand and is not signed with ЭЦП; the mobile app cannot download PDFs yet |
| Voting | No in-person meeting form (Art. 42); no procedure to annul a ballot |
| Infrastructure | The rate limiter is in-memory and does not scale across several servers |
| Localization | Translations were made by a model and need review by a native speaker; notifications, emails and PDFs are still in Russian |

---

## 6. Potential Improvements

1. **AI:** more legal sources in the corpus (Rules of maintenance, orders), quality metrics dashboard from `ai_jobs`.
2. **Real integrations:**
   - SIGEX for ЭЦП;
   - the Kaspi merchant API for automatic payment confirmation;
   - an SMS gateway and push notifications.
3. **Documents:** ЭЦП signing of the annual report, PDF download in the mobile app.
4. **Localization:** native-speaker review; Kazakh notifications, emails and PDFs.
5. **Scale and operations:** Redis for rate limiting and queues, deployment to Yandex Cloud (`kz1` region, as required by the personal data law).
6. **Before the first real building:** an external penetration test focused on house isolation and voting integrity, and a backup restore drill.
7. **Later:** contractor accounts, meter readings, budget planning, 1C integration, multi-house associations.
