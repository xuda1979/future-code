from experiments_v13.summary_span import check, rank


def test_exact_population_summary_characterization_witness():
    result = check()
    assert result['support_epochs'] == 90
    assert result['rank_with_paired_score'] == result['pairwise_feature_rank'] + 1
    assert result['minimal_expectation_features_for_this_single_paired_score'] == 1


def test_rational_rank_handles_constant_and_dependent_features():
    assert rank([[1, 2, 3], [2, 4, 6]]) == 1
    assert rank([[1, 0], [1, 1], [1, 2]]) == 2
