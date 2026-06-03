package com.firstaid.copilot

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test

class MainActivityFixtureRunnerTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun runAllFixtures_reportsAllExpectedChannelsPassed() {
        composeRule.onNodeWithText("旧 Fixture").performClick()
        composeRule.onNodeWithText("FirstAid Copilot").assertIsDisplayed()
        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule
                .onAllNodesWithText("fixtures:loaded count=8")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }

        composeRule.onNodeWithText("Run All Fixtures").performClick()

        composeRule.waitUntil(timeoutMillis = 5_000) {
            composeRule
                .onAllNodesWithText("run_all:complete passed=8/8")
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        composeRule.onNodeWithText("run_all:complete passed=8/8").assertIsDisplayed()
    }
}
