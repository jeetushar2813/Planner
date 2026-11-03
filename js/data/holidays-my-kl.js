// Malaysian public holidays for Kuala Lumpur (Wilayah Persekutuan Kuala Lumpur).
//
// Source: "Jadual Hari Kelepasan Am Persekutuan" and "Jadual Hari Kelepasan Am Negeri"
// for 2026 and 2027, published by Bahagian Kabinet, Jabatan Perdana Menteri
// (https://www.kabinet.gov.my/hari-kelepasan-am/). The W.P. Kuala Lumpur column was read
// from both tables.
//
// kind:
//   federal      gazetted for the whole country (also applies in Kuala Lumpur)
//   kl           state-level holiday that applies in Kuala Lumpur
//   replacement  the next working day, because a holiday fell on a Sunday (Holidays Act 1951,
//                section 3). The government announces these, so check them each year.
// tentative: true  the government marks these "subject to change" (the date follows the moon).
//
// To add a year, append a block below and keep the dates as YYYY-MM-DD. Nothing else changes.

export const MY_KL_SOURCE = 'Cabinet Division, Prime Minister’s Department (kabinet.gov.my)';

const H = (date, name, kind = 'federal', tentative = false) => ({ date, name, kind, tentative });

export const MY_KL_HOLIDAYS = {
  2026: [
    H('2026-01-01', 'New Year’s Day', 'kl'),
    H('2026-02-01', 'Thaipusam', 'kl'),
    H('2026-02-01', 'Federal Territory Day', 'kl'),
    H('2026-02-02', 'Replacement holiday (Thaipusam)', 'replacement'),
    H('2026-02-03', 'Replacement holiday (Federal Territory Day)', 'replacement'),
    H('2026-02-17', 'Chinese New Year'),
    H('2026-02-18', 'Chinese New Year (second day)'),
    H('2026-03-07', 'Nuzul Al-Quran', 'kl'),
    H('2026-03-21', 'Hari Raya Aidilfitri', 'federal', true),
    H('2026-03-22', 'Hari Raya Aidilfitri (second day)', 'federal', true),
    H('2026-03-23', 'Replacement holiday (Hari Raya Aidilfitri)', 'replacement'),
    H('2026-05-01', 'Labour Day'),
    H('2026-05-27', 'Hari Raya Haji', 'federal', true),
    H('2026-05-31', 'Wesak Day'),
    H('2026-06-01', 'Agong’s Birthday'),
    H('2026-06-02', 'Replacement holiday (Wesak Day)', 'replacement'),
    H('2026-06-17', 'Awal Muharram'),
    H('2026-08-25', 'Prophet Muhammad’s Birthday'),
    H('2026-08-31', 'Merdeka Day'),
    H('2026-09-16', 'Malaysia Day'),
    H('2026-11-08', 'Deepavali', 'federal', true),
    H('2026-11-09', 'Replacement holiday (Deepavali)', 'replacement'),
    H('2026-12-25', 'Christmas Day')
  ],
  2027: [
    H('2027-01-01', 'New Year’s Day', 'kl'),
    H('2027-01-22', 'Thaipusam', 'kl'),
    H('2027-02-01', 'Federal Territory Day', 'kl'),
    H('2027-02-06', 'Chinese New Year'),
    H('2027-02-07', 'Chinese New Year (second day)'),
    H('2027-02-08', 'Replacement holiday (Chinese New Year)', 'replacement'),
    H('2027-02-24', 'Nuzul Al-Quran', 'kl'),
    H('2027-03-10', 'Hari Raya Aidilfitri', 'federal', true),
    H('2027-03-11', 'Hari Raya Aidilfitri (second day)', 'federal', true),
    H('2027-05-01', 'Labour Day'),
    H('2027-05-17', 'Hari Raya Haji', 'federal', true),
    H('2027-05-20', 'Wesak Day'),
    H('2027-06-06', 'Awal Muharram'),
    H('2027-06-07', 'Agong’s Birthday'),
    H('2027-06-08', 'Replacement holiday (Awal Muharram)', 'replacement'),
    H('2027-08-15', 'Prophet Muhammad’s Birthday'),
    H('2027-08-16', 'Replacement holiday (Prophet Muhammad’s Birthday)', 'replacement'),
    H('2027-08-31', 'Merdeka Day'),
    H('2027-09-16', 'Malaysia Day'),
    H('2027-10-28', 'Deepavali', 'federal', true),
    H('2027-12-25', 'Christmas Day')
  ]
};

export const MY_KL_YEARS = Object.keys(MY_KL_HOLIDAYS).map(Number).sort();
