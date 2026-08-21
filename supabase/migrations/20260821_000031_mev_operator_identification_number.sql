-- SW-73 tableaux 10/11: the CSR's CN= field is the exploitant's "numéro d'identification",
-- an identifier Revenu Québec assigns to the person, distinct from the business's legal name
-- or its TPS/TVQ registration numbers. Nothing in the existing schema held it; without this
-- column, mev-enrollment.js was falling back to legal_name for CN, which is not what SW-73
-- specifies. Lives on mev_partner_config (enrolment identity), not restaurants (business
-- info), since it belongs to the person enrolling, not the business itself.

alter table public.mev_partner_config
  add column if not exists operator_identification_number text;
