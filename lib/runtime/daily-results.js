'use strict';

// Daily post-results model jobs horen alleen te draaien wanneer de results
// check daadwerkelijk nieuwe outcomes heeft vastgelegd. Zonder nieuwe settled
// bets krijg je anders "model bijgewerkt" signalen op een dag waarop er in de
// praktijk niets is afgelopen.
function shouldRunPostResultsModelJobs(updatedCount) {
  const updated = Number.isFinite(updatedCount) ? updatedCount : 0;
  if (updated > 0) {
    return { shouldRun: true, reason: 'new_results_settled' };
  }
  return { shouldRun: false, reason: 'no_new_results' };
}

module.exports = {
  shouldRunPostResultsModelJobs,
};
