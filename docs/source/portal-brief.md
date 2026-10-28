# Project Brief: AI-Powered Home Improvement Loan Application Assistant

> Source: Gauntlet AI partner portal, project `UXjtHikT8IdhVSUblmIS`
> (<https://portal.gauntletai.com/projects/UXjtHikT8IdhVSUblmIS>), captured 2026-10-28.
> Transcribed from the page text; wording unchanged.

**Partner:** GoodLeap
**Tier:** Silver · **Version:** 1 · **Tags:** AI-Solution, Software Engineer - AI Transformation
**Last updated:** 10/20/2026

## PRD

Contractor partners struggle to explain complex loan products and promotional terms on-site,
leading to a 38% application abandonment rate (vs 10-minute industry benchmark, current average
22 minutes). Biggest drop-offs occur at income verification and loan product selection steps,
and manual review of uploaded documents (pay stubs, estimates, scope letters) causes delays.

## Problem & Context

### Business context

A consumer home improvement finance company originates ~$2B annually in loans ($5K-$100K, 5-25
year terms, promotional APR structures) through 15,000+ contractor partners using a
React/TypeScript/Node.js partner portal on AWS. Stakeholders want to reduce application
abandonment and help contractors close deals faster by simplifying loan product explanation and
speeding up document review, while staying compliant with TILA/RESPA regulations and avoiding any
AI-implied credit decisions.

### Impact metrics

VP of Contractor Partnerships estimates a 10% increase in contractor deal closure could yield
$200M in additional annual origination volume. Key metrics include application completion rate
(target under 10 minutes vs current 22), abandonment rate reduction (from 38%), time-to-decision,
contractor adoption rate, and document review turnaround time.

## Requirements & Success Criteria

### Functional requirements

Design and prototype an AI-powered solution addressing contractor/homeowner friction in the loan
application process. Must demonstrate a realistic end-to-end interaction tied to the stated
problem (e.g., explaining loan products, estimating payments, or extracting document data). Must
include a solution design document covering problem framing, architecture, AI design decisions,
compliance/safety, rollout plan, and monitoring/impact evaluation.

### Performance benchmarks

Target application completion time under 10 minutes (industry benchmark); reduce 38% abandonment
rate; contractors should be able to provide payment estimates within ~30 seconds during customer
interactions.

### Code quality expectations

Prototype should be well-structured, documented, runnable locally within 5 minutes via README,
with clear architecture description. Reviewers expect candidate to be able to explain every line
even if AI-assisted.

### Time constraints

2-4 hours

### Technical contact

Recruiter (for questions)

## Technology

| Category | Value |
| --- | --- |
| Required languages | TypeScript, Node.js |
| AI / ML frameworks | Anthropic API, OpenAI API (or Google/open-source LLMs), prompt engineering, RAG patterns, embeddings, evaluation frameworks, guardrails tooling |
| Dev tools | React, Node.js/TypeScript backend, Zapier, Jira Service Management (JSM), Microsoft 365, GitHub |
| Cloud platforms | AWS (ECS, RDS Postgres, S3, SQS), Snowflake data warehouse |

### Other requirements

Must include at least one guardrail preventing non-compliant output; must use mocked financial
service APIs (no real API keys for financial services) but a real LLM API for AI interactions;
solution must integrate conceptually with existing APIs (loan product catalog, credit decision
engine, Plaid income verification, contractor profile service, document management).

### Off-limits tech

No AI system may make or imply a credit decision; all borrower-facing communications must include
TILA/RESPA required disclosures; no real financial service API keys should be used (must be
mocked).

## Submission & AI Policy

**AI usage documentation:** Required

**Required deliverables:**

- Source Code
- Technical Documentation
- Deployment Guide

**Attachments:** `ai_solutions_engineer_takehome-final - Copy.pdf` (marked Confidential; not
committed to this repository)

**Links:** none

Submission is made from the portal page and is tied to this project version.
