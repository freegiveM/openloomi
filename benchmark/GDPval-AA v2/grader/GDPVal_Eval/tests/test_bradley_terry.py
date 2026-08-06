"""Tests for the Bradley-Terry ELO rating model."""

import pytest

from gdpval.elo.bradley_terry import BradleyTerry, DEFAULT_ANCHOR_ELO, DEFAULT_ANCHOR_MODEL


class TestBradleyTerry:
    def test_anchor_model_receives_anchor_elo(self):
        """The anchor model should always have exactly the anchor ELO."""
        matches = [
            ("gpt-5.1", "model_b"),
            ("gpt-5.1", "model_c"),
            ("model_b", "model_c"),
        ]
        bt = BradleyTerry()
        ratings = bt.fit(matches)
        assert abs(ratings[DEFAULT_ANCHOR_MODEL] - DEFAULT_ANCHOR_ELO) < 1e-6

    def test_stronger_model_gets_higher_elo(self):
        """A model that wins all matches should have a higher ELO than one that loses all."""
        matches = [
            ("strong", DEFAULT_ANCHOR_MODEL),
            ("strong", DEFAULT_ANCHOR_MODEL),
            ("strong", DEFAULT_ANCHOR_MODEL),
        ]
        bt = BradleyTerry()
        ratings = bt.fit(matches)
        assert ratings["strong"] > ratings[DEFAULT_ANCHOR_MODEL]

    def test_all_models_in_output(self):
        """All models seen in match data should appear in the ratings dict."""
        matches = [
            (DEFAULT_ANCHOR_MODEL, "alpha"),
            ("alpha", "beta"),
            (DEFAULT_ANCHOR_MODEL, "beta"),
        ]
        bt = BradleyTerry()
        ratings = bt.fit(matches)
        assert set(ratings.keys()) == {DEFAULT_ANCHOR_MODEL, "alpha", "beta"}

    def test_empty_matches_raises(self):
        """An empty match list should raise ValueError."""
        bt = BradleyTerry()
        with pytest.raises(ValueError, match="at least one"):
            bt.fit([])

    def test_missing_anchor_raises(self):
        """If the anchor model is absent from matches, ValueError should be raised."""
        bt = BradleyTerry()
        with pytest.raises(ValueError, match="Anchor model"):
            bt.fit([("model_a", "model_b")])

    def test_symmetric_wins_yield_equal_elo(self):
        """When two models split wins evenly, their ELOs should be nearly equal."""
        anchor = DEFAULT_ANCHOR_MODEL
        matches = [
            (anchor, "rival"),
            ("rival", anchor),
            (anchor, "rival"),
            ("rival", anchor),
        ]
        bt = BradleyTerry()
        ratings = bt.fit(matches)
        assert abs(ratings[anchor] - ratings["rival"]) < 10.0

    def test_ratings_property_after_fit(self):
        """The ratings property should reflect the most recent fit."""
        bt = BradleyTerry()
        bt.fit([(DEFAULT_ANCHOR_MODEL, "other")])
        assert DEFAULT_ANCHOR_MODEL in bt.ratings

    def test_custom_anchor_elo(self):
        """Custom anchor ELO values should be respected."""
        matches = [(DEFAULT_ANCHOR_MODEL, "other")]
        bt = BradleyTerry(anchor_elo=2000.0)
        ratings = bt.fit(matches)
        assert abs(ratings[DEFAULT_ANCHOR_MODEL] - 2000.0) < 1e-6
