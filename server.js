const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { Octokit } = require("@octokit/rest");
const { createAppAuth } = require("@octokit/auth-app");
const cookieParser = require("cookie-parser");
const axios = require("axios");
const crypto = require("crypto");
const { Keypair, Transaction } = require("@solana/web3.js"); // Import Keypair
const { App } = require("@octokit/app");
require("dotenv").config();

const app = express();
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());

const PORT = process.env.PORT || 3001;

// GitHub App initialization
const gitHubApp = new App({
  appId: process.env.GITHUB_APP_ID,
  privateKey: process.env.GITHUB_PRIVATE_KEY,
  oauth: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
  webhooks: {
    secret: process.env.GITHUB_WEBHOOK_SECRET,
  },
});

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Database setup
async function setupDatabase() {
  let client;
  try {
    client = await pool.connect();

    // Create tables (if they don't exist)
    await client.query(`
          CREATE TABLE IF NOT EXISTS users (
              id SERIAL PRIMARY KEY,
              github_id INTEGER UNIQUE NOT NULL,
              github_installation_id TEXT,
              total_earnings NUMERIC DEFAULT 0,
              aadhaar_pan TEXT,
              is_verified BOOLEAN DEFAULT FALSE,
              is_active BOOLEAN,
              authorization_revoked BOOLEAN,
              email TEXT,
              name TEXT,
              personal_access_token TEXT,
              expiry_date TIMESTAMP,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              refresh_token TEXT,
              refresh_token_expiry_date TIMESTAMP,
              solana_address TEXT,
              encrypted_private_key TEXT 
          );

          CREATE TABLE IF NOT EXISTS bounties (
              id SERIAL PRIMARY KEY,
              issue_id NUMERIC NOT NULL,
              amount NUMERIC NOT NULL,
              status TEXT NOT NULL,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              repository TEXT,
              issue_title TEXT,
              issue_url TEXT,
              creator_id INTEGER REFERENCES users(github_id),
              claimed_by INTEGER REFERENCES users(github_id)
          );

          CREATE TABLE IF NOT EXISTS bounty_claims (
              id SERIAL PRIMARY KEY,
              bounty_id INTEGER REFERENCES bounties(id),
              user_id INTEGER REFERENCES users(github_id),
              claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              pull_request NUMERIC
          );
      `);

    // Create a helper function to check for unique open bounties
    await client.query(`
          CREATE OR REPLACE FUNCTION check_unique_open_bounty() RETURNS TRIGGER AS $$
          BEGIN
              IF (NEW.status = 'open' AND 
                  EXISTS (SELECT 1 FROM bounties 
                          WHERE issue_id = NEW.issue_id AND id != NEW.id AND status = 'open')) THEN
                  RAISE EXCEPTION 'An open bounty already exists for this issue.';
              END IF;
              RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
      `);

    // Create a trigger to call the helper function on bounties insert/update
    await client.query(`
          CREATE TRIGGER unique_open_bounty_trigger
          BEFORE INSERT OR UPDATE ON bounties
          FOR EACH ROW
          EXECUTE FUNCTION check_unique_open_bounty();
      `);

    // Create a helper function to check for unique claims on open bounties
    await client.query(`
          CREATE OR REPLACE FUNCTION check_unique_claim_on_open_bounty() RETURNS TRIGGER AS $$
          BEGIN
              IF (EXISTS (SELECT 1 FROM bounties 
                          WHERE id = NEW.bounty_id AND status = 'open') AND 
                  EXISTS (SELECT 1 FROM bounty_claims 
                          WHERE pull_request_number = NEW.pull_request_number 
                          AND bounty_id IN (SELECT id FROM bounties WHERE status = 'open')
                          AND id != NEW.id)) THEN
                  RAISE EXCEPTION 'A claim already exists for this pull request on an open bounty.';
              END IF;
              RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
      `);

    // Create a trigger to call the helper function on bounty_claims insert/update
    await client.query(`
          CREATE TRIGGER unique_claim_on_open_bounty_trigger
          BEFORE INSERT OR UPDATE ON bounty_claims
          FOR EACH ROW
          EXECUTE FUNCTION check_unique_claim_on_open_bounty();
      `);

    console.log("Database setup complete");
  } catch (err) {
    console.error("Error setting up database:", err);
  } finally {
    if (client) {
      client.release();
    }
  }
}

setupDatabase();

// Middleware for authentication
const authenticateUser = async (req, res, next) => {
  const userId = req.cookies?.user_id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE github_id = $1",
      [userId]
    );
    const user = result.rows[0];

    if (!user || user.authorization_revoked) {
      return res
        .status(401)
        .json({ error: "User not found or authorization revoked" });
    }

    // Check if the access token is expired
    if (new Date() > new Date(user.expiry_date)) {
      // Refresh the access token
      const newAccessToken = await refreshGitHubToken(userId);
      user.personal_access_token = newAccessToken;
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Routes
app.get("/auth/github", (req, res) => {
  const redirectUri = process.env.GITHUB_AUTH_CALLBACK_URI;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const scopes = ["user:email", "read:user"];

  const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=${encodeURIComponent(
    scopes.join(" ")
  )}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.json({ authUrl });
});

app.get("/auth/github/callback", async (req, res) => {
  const code = req.query.code;
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_AUTH_CALLBACK_URI;

  try {
    // Exchange code for access token
    const accessTokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
      },
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    const {
      access_token,
      expires_in,
      refresh_token,
      refresh_token_expires_in,
    } = accessTokenResponse.data;

    // Fetch user details
    const { data: user } = await axios.get("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    // Get primary email
    const primaryEmail = (
      await axios.get("https://api.github.com/user/emails", {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).data.find((email) => email.primary)?.email;

    // Insert or update user in the database
    await pool.query(
      `
      INSERT INTO users (github_id, name, email, personal_access_token, expiry_date, refresh_token, refresh_token_expiry_date, is_active, authorization_revoked)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (github_id) DO UPDATE SET
      name = EXCLUDED.name,
      email = EXCLUDED.email,
      personal_access_token = EXCLUDED.personal_access_token,
      expiry_date = EXCLUDED.expiry_date,
      refresh_token = EXCLUDED.refresh_token,
      refresh_token_expiry_date = EXCLUDED.refresh_token_expiry_date,
      is_active = EXCLUDED.is_active,
      authorization_revoked = EXCLUDED.authorization_revoked
    `,
      [
        user.id,
        user.login,
        primaryEmail,
        access_token,
        new Date(Date.now() + expires_in * 1000),
        refresh_token,
        new Date(Date.now() + refresh_token_expires_in * 1000),
        true,
        false,
      ]
    );

    res.cookie("user_id", user.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Error during authentication:", error);
    res.status(500).json({ error: "Error during authentication" });
  }
});

app.get("/api/checkAuth", authenticateUser, (req, res) => {
  res.status(200).json({
    authenticated: true,
    isAppInstalled: req.user.github_installation_id !== null,
    aadhaarPanVerified: req.user.aadhaar_pan !== null,
    aadhaarPanSet: req.user.aadhaar_pan,
    solanaAddressSet: req.user.solana_address !== null,
  });
});

app.post("/api/user/verify", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { aadhaarPan } = req.body;
    const isVerified = await verifyAadhaarPan(aadhaarPan, req.user.github_id);
    if (isVerified) {
      res.json({ message: "Verification successful" });
    } else {
      res.status(400).json({ error: "Verification failed" });
    }
  } catch (error) {
    console.error("Error verifying Aadhaar/PAN:", error);
    res.status(500).json({ error: "Failed to verify Aadhaar/PAN" });
  } finally {
    client.release();
  }
});

app.post("/api/logout", authenticateUser, async (req, res) => {
  try {
    // Clear the user_id cookie
    res.clearCookie("user_id", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
    });

    res.json({ message: "Logout successful" });
  } catch (error) {
    console.error("Error during logout:", error);
    res.status(500).json({ error: "Error during logout" });
  }
});

// app installation
app.get("/api/github/login", authenticateUser, (req, res) => {
  const githubAuthUrl = `https://github.com/apps/${process.env.GITHUB_APP_SLUG}/installations/new`;
  res.json({ githubAuthUrl });
});

app.get("/api/github/callback", authenticateUser, async (req, res) => {
  const { installation_id, setup_action } = req.query;

  if (!installation_id) {
    return res.status(400).json({ error: "Invalid installation_id provided" });
  }

  const client = await pool.connect();
  try {
    const result = await client.query(
      `
        SELECT github_installation_id
        FROM users
        WHERE github_id = $1
        FOR UPDATE
      `,
      [req.user.github_id]
    );

    if (
      setup_action !== "update" &&
      result.rows[0].github_installation_id === installation_id
    ) {
      return res.status(200).json({ isAppInstalled: true });
    }

    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: installation_id,
      },
    });
    const { data: installation } = await appOctokit.apps.getInstallation({
      installation_id,
    });

    // Update the user's github_installation_id in the database
    await client.query(
      `
        UPDATE users
        SET github_installation_id = $1
        WHERE github_id = $2
      `,
      [installation_id, installation.account.id]
    );

    res.json({ isAppInstalled: true });
  } catch (error) {
    console.error("Error in GitHub callback:", error);
    res.status(500).json({ error: "Failed to update GitHub installation" });
  } finally {
    client.release();
  }
});

app.post("/api/user/set_solana-address", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const { solanaAddress } = req.body;
    await client.query(
      "UPDATE users SET solana_address = $1 WHERE github_id = $2",
      [solanaAddress, req.user.github_id]
    );
    res.json({ message: "Solana address connected" });
  } catch (error) {
    console.error("Error connecting Solana address:", error);
    res.status(500).json({ error: "Failed to connect Solana address" });
  } finally {
    client.release();
  }
});

app.get("/api/created_bounties", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM bounties WHERE creator_id = $1",
      [req.user.github_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching bounties:", error);
    res.status(500).json({ error: "Failed to fetch bounties" });
  } finally {
    client.release();
  }
});

app.get("/api/user/bounties-to-approve", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      WITH user_bounties AS (
        SELECT id FROM bounties WHERE creator_id = $1 AND (status = 'open' OR status = 'payment pending')
      )
      SELECT 
        b.id,
        b.issue_id,
        b.amount,
        b.repository,
        b.issue_title,
        b.issue_url,
        b.status, 
        b.claimed_by, 
        json_agg(json_build_object(
          'claimant_id', u.github_id,
          'claimant_name', u.name,
          'claimant_email', u.email,
          'claimed_at', bc.claimed_at
        )) FILTER (WHERE u.github_id IS NOT NULL) AS claimants
      FROM user_bounties ub
      JOIN bounties b ON ub.id = b.id
      LEFT JOIN bounty_claims bc ON b.id = bc.bounty_id
      LEFT JOIN users u ON bc.user_id = u.github_id
      GROUP BY b.id, b.issue_id, b.amount, b.repository, b.issue_title, b.issue_url, b.status, b.claimed_by
      HAVING COUNT(u.github_id) > 0
      ORDER BY b.created_at DESC
    `,
      [req.user.github_id]
    );

    // Filter out any null values that might have slipped through
    const filteredResults = result.rows
      .map((row) => ({
        ...row,
        claimants: row.claimants.filter(
          (claimant) => claimant.claimant_id !== null
        ),
      }))
      .filter((row) => row.claimants.length > 0);

    res.json(filteredResults);
  } catch (error) {
    console.error("Error fetching bounties to approve:", error);
    res.status(500).json({ error: "Failed to fetch bounties to approve" });
  } finally {
    client.release();
  }
});

app.post("/api/approve-bounty-verify", authenticateUser, async (req, res) => {
  const { bountyId, claimantId } = req.body;
  const client = await pool.connect();

  try {
    // 1. Check if the bounty exists
    const bountyResult = await client.query(
      "SELECT * FROM bounties WHERE id = $1",
      [bountyId]
    );
    if (bountyResult.rows.length === 0) {
      return res.status(404).json({ error: "Bounty not found" });
    }
    const bounty = bountyResult.rows[0];

    // 2. Check if the claimant has claimed this bounty
    const claimResult = await client.query(
      "SELECT * FROM bounty_claims WHERE bounty_id = $1 AND user_id = $2",
      [bountyId, claimantId]
    );
    if (claimResult.rows.length === 0) {
      return res
        .status(400)
        .json({ error: "Claimant has not claimed this bounty" });
    }

    // 3. Check if the user is the owner of the bounty
    if (bounty.creator_id !== req.user.github_id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 4. Fetch owner and claimant details
    const ownerResult = await client.query(
      "SELECT * FROM users WHERE github_id = $1",
      [bounty.creator_id]
    );
    const claimantResult = await client.query(
      "SELECT * FROM users WHERE github_id = $1",
      [claimantId]
    );

    if (ownerResult.rows.length === 0 || claimantResult.rows.length === 0) {
      return res.status(400).json({ error: "Owner or claimant not found" });
    }

    const owner = ownerResult.rows[0];
    const claimant = claimantResult.rows[0];

    // 5. Check if Solana addresses are available
    if (!owner.solana_address || !claimant.solana_address) {
      return res
        .status(400)
        .json({ error: "Solana address of owner or claimant not found" });
    }

    // 6. Update bounty status to 'payment pending'
    await client.query(
      "UPDATE bounties SET status = $1, claimed_by = $2 WHERE id = $3",
      ["payment pending", claimantId, bountyId]
    );

    res.json({
      fromWalletAddress: owner.solana_address,
      toWalletAddress: claimant.solana_address,
      amount: bounty.amount,
      bountyId: bountyId,
    });
  } catch (error) {
    console.error("Error approving bounty:", error);
    res.status(500).json({ error: "Failed to approve bounty" });
  } finally {
    client.release();
  }
});

app.get("/api/user/claimed-bounties", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
      SELECT 
        b.id,
        b.issue_id,
        b.amount,
        b.status,
        b.repository,
        b.issue_title,
        b.issue_url,
        bc.claimed_at,
        CASE 
          WHEN b.claimed_by = $1 THEN 'Accepted'
          WHEN b.claimed_by IS NOT NULL AND b.claimed_by != $1 THEN 'Rejected'
          ELSE 'Pending'
        END AS claim_status
      FROM bounty_claims bc
      JOIN bounties b ON bc.bounty_id = b.id
      WHERE bc.user_id = $1
      ORDER BY bc.claimed_at DESC
    `,
      [req.user.github_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching claimed bounties:", error);
    res.status(500).json({ error: "Failed to fetch claimed bounties" });
  } finally {
    client.release();
  }
});

app.put("/api/bounty/:id", authenticateUser, async (req, res) => {
  const bountyId = req.params.id;
  const { amount } = req.body;

  const client = await pool.connect();
  try {
    // Check if the bounty exists and the user is the owner
    const bountyResult = await client.query(
      "SELECT * FROM bounties WHERE id = $1 AND creator_id = $2",
      [bountyId, req.user.github_id]
    );
    if (bountyResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Bounty not found or you are not the owner" });
    }
    
    const bounty = bountyResult.rows[0];

    const oldAmount = bounty.amount; 
    const newAmount = req.body.amount;
  
    // Update the bounty amount
    await client.query(
      "UPDATE bounties SET amount = $1 WHERE id = $2",
      [newAmount, bountyId]
    );
  
    // Fetch associated pull requests
    const pullRequestsResult = await client.query(
      "SELECT pull_request FROM bounty_claims WHERE bounty_id = $1",
      [bountyId]
    );

    console.log(`Updating bounty amount from ${oldAmount} to ${newAmount} on issue #${bounty.issue_id}`);

    const pullRequestNumbers = pullRequestsResult.rows.map(row => row.pull_request);
  console.log(`Pull request numbers: ${pullRequestNumbers}`);
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: req.user.github_installation_id,
      },
    });
    console.log(`Updating bounty amount from ${oldAmount} to ${newAmount} on issue #${bounty.issue_id}`);
  
    // Create comment on the issue
    try {
      // Create comment on the issue
      await appOctokit.rest.issues.createComment({
        owner: bounty.repository.split("/")[0],
        repo: bounty.repository.split("/")[1],
        issue_number: bounty.issue_id,
        body: `The bounty amount for this issue has been updated from ${oldAmount} to ${newAmount}.`
      });
    } catch (error) {
      console.error('Error creating comment on issue:', error);
      // Handle the error appropriately, e.g., log it, send an error response, or notify the user
    }
  
    // Create comments on the pull requests
    for (const prNumber of pullRequestNumbers) {
      console.log(`Updating bounty amount on PR #${prNumber}`);
      await appOctokit.rest.pulls.createReviewComment({
        owner: bounty.repository.split("/")[0],
        repo: bounty.repository.split("/")[1],
        pull_number: prNumber,
        body: `The bounty amount for this issue has been updated from ${oldAmount} to ${newAmount}.`,
        // You might need to adjust the following based on your PR structure
        commit_id: 'latest', // Or fetch the latest commit ID for the PR
        path: '', // Or specify a relevant file path if needed
        line: 1,
      });
    }
  
    res.json({ message: "Bounty amount updated successfully" });
  } catch (error) {
    console.error("Error updating bounty:", error);
    res.status(500).json({ error: "Failed to update bounty" });
  } finally {
    client.release();
  }
});

app.delete("/api/bounty/:id", authenticateUser, async (req, res) => {
  const bountyId = req.params.id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if the bounty exists and the user is the owner
    const bountyResult = await client.query(
      "SELECT * FROM bounties WHERE id = $1 AND creator_id = $2",
      [bountyId, req.user.github_id]
    );
    if (bountyResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ error: "Bounty not found or you are not the owner" });
    }
    const bounty = bountyResult.rows[0];

    // Get all claimants
    const claimantsResult = await client.query(
      "SELECT DISTINCT user_id FROM bounty_claims WHERE bounty_id = $1",
      [bountyId]
    );
    const claimants = claimantsResult.rows;

    // Delete bounty claims
    await client.query("DELETE FROM bounty_claims WHERE bounty_id = $1", [
      bountyId,
    ]);

    // Delete the bounty
    await client.query("DELETE FROM bounties WHERE id = $1", [bountyId]);

    await client.query("COMMIT");

    // Notify claimants
    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: req.user.github_installation_id,
      },
    });

    for (const claimant of claimants) {
      try {
        await appOctokit.rest.issues.createComment({
          owner: bounty.repository.split("/")[0],
          repo: bounty.repository.split("/")[1],
          issue_number: bounty.issue_id,
          body: `@${claimant.user_id} The bounty you claimed (ID: ${bountyId}) has been deleted by the owner.`,
        });
      } catch (error) {
        console.error(`Error notifying claimant ${claimant.user_id}:`, error);
        // Continue with other notifications even if one fails
      }
    }

    res.json({ message: "Bounty deleted successfully and claimants notified" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting bounty:", error);
    res.status(500).json({ error: "Failed to delete bounty" });
  } finally {
    client.release();
  }
});

app.post("/api/complete-bounty", authenticateUser, async (req, res) => {
  const { bountyId } = req.body;
  const client = await pool.connect();

  try {
    await client.query("UPDATE bounties SET status = $1 WHERE id = $2", [
      "completed",
      bountyId,
    ]);
    res.json({ message: "Bounty completed successfully" });
  } catch (error) {
    console.error("Error completing bounty:", error);
    res.status(500).json({ error: "Failed to complete bounty" });
  } finally {
    client.release();
  }
});

app.get("/api/user/details", authenticateUser, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM users WHERE github_id = $1",
      [req.user.github_id]
    );
    if (result.rows.length > 0) {
      res.json({
        name: result.rows[0].name,
        email: result.rows[0].email,
        solana_address: result.rows[0].solana_address,
      });
    } else {
      res.status(404).json({ error: "User not found" });
    }
  } catch (error) {
    console.error("Error retrieving user profile:", error);
    res.status(500).json({ error: "Failed to retrieve user profile" });
  } finally {
    client.release();
  }
});

app.post("/api/github/webhooks", async (req, res) => {
  const event = req.headers["x-github-event"];
  const signature = req.headers["x-hub-signature-256"];
  const body = req.body;

  try {
    await gitHubApp.webhooks.verify(body, signature);
    const payload = body;

    if (event === "installation" && payload.action === "deleted") {
      const githubId = payload.sender.id;
      const client = await pool.connect();

      try {
        await client.query(
          "UPDATE users SET github_installation_id = NULL WHERE github_id = $1",
          [githubId]
        );
        console.log(`User ${githubId} uninstalled the GitHub app.`);
      } finally {
        client.release();
      }
    }

    if (event === "issue_comment" && payload.action === "created") {
      const comment = payload.comment.body;
      if (payload.issue.pull_request) {
        // This is a comment on a pull request
        if (comment.startsWith("/claim-bounty")) {
          await handleBountyClaim(payload);
        }
      } else {
        // This is a comment on an issue
        if (comment.startsWith("/create-bounty")) {
          await handleBountyCreation(payload);
        }
      }
    } else if (event === "issues" && payload.action === "opened") {
      const issueDescription = payload.issue.body;
      if (issueDescription && issueDescription.includes("/create-bounty")) {
        await handleBountyCreation(payload);
      }
    } else if (event === "pull_request" && payload.action === "opened") {
      const prBody = payload.pull_request.body;
      if (prBody && prBody.includes("/claim-bounty")) {
        await handleBountyClaim(payload);
      }
    }

    res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).json({ error: "Failed to process webhook" });
  }
});

app.post("/api/wallet/generate-keypair", authenticateUser, async (req, res) => {
  try {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();

    // Encrypt and store the private key in the database
    const encryptedPrivateKey = encryptPrivateKey(keypair.secretKey);
    await pool.query(
      "UPDATE users SET encrypted_private_key = $1 WHERE github_id = $2",
      [encryptedPrivateKey, req.user.github_id]
    );

    res.json({ publicKey });
  } catch (error) {
    console.error("Error generating keypair:", error);
    res.status(500).json({ error: "Failed to generate keypair" });
  }
});

app.post("/api/wallet/sign-transaction", authenticateUser, async (req, res) => {
  try {
    const { transaction } = req.body;

    // Retrieve and decrypt the user's private key from the database
    const result = await pool.query(
      "SELECT encrypted_private_key FROM users WHERE github_id = $1",
      [req.user.github_id]
    );
    const encryptedPrivateKey = result.rows[0].encrypted_private_key;
    const privateKey = decryptPrivateKey(encryptedPrivateKey); // Implement your decryption logic

    const keypair = Keypair.fromSecretKey(privateKey);
    const deserializedTransaction = Transaction.from(transaction);
    const signedTransaction = await keypair.signTransaction(
      deserializedTransaction
    );

    res.json({ signedTransaction: signedTransaction.serialize() });
  } catch (error) {
    // ... error handling
  }
});

const refreshGitHubToken = async (userId) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT refresh_token, refresh_token_expiry_date FROM users WHERE github_id = $1",
      [userId]
    );
    const { refresh_token, refresh_token_expiry_date } = result.rows[0];

    // Check if the refresh token is still valid
    if (new Date() > new Date(refresh_token_expiry_date)) {
      await client.query(
        `
        UPDATE users SET
          personal_access_token = $1,
          refresh_token = $2,
          authorization_revoked = $3
        WHERE github_id = $4
      `,
        [null, null, true, userId]
      );

      throw new Error(
        "Refresh token has expired and authorization has been revoked"
      );
    }

    // Exchange the refresh token for a new access token
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        refresh_token: refresh_token,
        grant_type: "refresh_token",
      },
      {
        headers: {
          Accept: "application/json",
        },
      }
    );

    const {
      access_token,
      expires_in,
      refresh_token: new_refresh_token,
      refresh_token_expires_in,
    } = tokenResponse.data;

    // Calculate new expiry dates
    const now = new Date();
    const newExpiryDate = new Date(now.getTime() + expires_in * 1000);
    const newRefreshTokenExpiryDate = refresh_token_expires_in
      ? new Date(now.getTime() + refresh_token_expires_in * 1000)
      : new Date(refresh_token_expiry_date); // Keep the old expiry if no new one provided

    // Update the tokens and expiry dates in the database
    await client.query(
      `
      UPDATE users SET
        personal_access_token = $1,
        expiry_date = $2,
        refresh_token = $3,
        refresh_token_expiry_date = $4
      WHERE github_id = $5
    `,
      [
        access_token,
        newExpiryDate,
        new_refresh_token || refresh_token, // Use the new refresh token if provided, otherwise keep the old one
        newRefreshTokenExpiryDate,
        userId,
      ]
    );

    return access_token;
  } catch (error) {
    console.error("Error refreshing GitHub token:", error);
    throw error;
  } finally {
    client.release();
  }
};

async function handleBountyCreation(payload) {
  let amount;
  if (payload.comment) {
    const match = payload.comment.body.match(/\/create-bounty\s+(\d+)/i);
    amount = match ? parseInt(match[1]) : null;
  } else if (payload.issue) {
    const match = payload.issue.body.match(/\/create-bounty\s+(\d+)/i);
    amount = match ? parseInt(match[1]) : null;
  }

  if (!amount) {
    console.log(
      "No valid bounty amount found in the comment or issue description"
    );
    return;
  }

  const issueId = payload.issue.id;
  const userId = payload.sender.id;
  console.log("Creating bounty for issue:", issueId, "with amount:", amount);

  const client = await pool.connect();
  try {

    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: payload.installation.id,
      },
    });
    // Check for existing open bounty
    const existingBountyResult = await client.query(
      "SELECT * FROM bounties WHERE issue_id = $1 AND status = 'open'",
      [issueId]
    );
    if (existingBountyResult.rows.length > 0) {
      // An open bounty already exists for this issue, create a comment
      await appOctokit.rest.issues.createComment({
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        issue_number: payload.issue.number,
        body: `⚠️ An open bounty already exists for this issue. You can only have one active bounty per issue at a time.`,
      });
      return;
    }

    const result = await client.query(
      "INSERT INTO bounties (issue_id, amount, status, creator_id, repository, issue_title, issue_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [
        issueId,
        amount,
        "open",
        userId,
        payload.repository.full_name,
        payload.issue.title,
        payload.issue.html_url,
      ]
    );
    const bountyId = result.rows[0].id;

    await appOctokit.rest.issues.createComment({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      issue_number: payload.issue.number,
      body: `Congratulations! A bounty of ${amount} rupees has been created for this issue.

1. To claim this bounty, type "/claim-bounty ${bountyId}" somewhere in the body of your PR or in a comment.
2. To receive payment, you must join Paisa-Baat (${process.env.FRONTEND_URL}) and complete authorization and wallet connection.
3. Once approved, payment can take up to 3-5 days to complete.
4. Thank you for contributing to ${payload.repository.full_name}!`,
    });

    return bountyId;
  } catch (error) {
    console.error("Error creating bounty:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function handleBountyClaim(payload) {
  let bountyId;
  let isPRComment = false;

  if (payload.comment) {
    const match = payload.comment.body.match(/\/claim-bounty\s+(\d+)/i);
    bountyId = match ? parseInt(match[1]) : null;
    isPRComment = true;
  } else if (payload.pull_request) {
    const match = payload.pull_request.body.match(/\/claim-bounty\s+(\d+)/i);
    bountyId = match ? parseInt(match[1]) : null;
  }

  if (!bountyId) {
    console.log(
      "No valid bounty ID found in the PR comment or pull request body"
    );
    return;
  }

  const userId = payload.sender.id;

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      "SELECT * FROM users WHERE github_id = $1",
      [userId]
    );

    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: process.env.GITHUB_APP_ID,
        privateKey: process.env.GITHUB_PRIVATE_KEY,
        installationId: payload.installation.id,
      },
    });

    const createComment = async (body) => {
      if (isPRComment) {
        await appOctokit.rest.issues.createComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          issue_number: payload.issue.number,
          body: body,
        });
      } else {
        await appOctokit.rest.pulls.createReviewComment({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          pull_number: payload.pull_request.number,
          body: body,
          commit_id: payload.pull_request.head.sha,
          path:
            payload.pull_request.changed_files > 0
              ? payload.pull_request.changed_files[0].filename
              : "",
          line: 1,
        });
      }
    };

    if (userResult.rows.length === 0) {
      await createComment(
        `To claim this bounty, you need to join Paisa-Baat first. Please visit ${process.env.FRONTEND_URL} to create an account and complete the authorization process.`
      );
      return;
    }

    const bountyResult = await client.query(
      "SELECT * FROM bounties WHERE id = $1 AND status = $2",
      [bountyId, "open"]
    );

    if (bountyResult.rows.length === 0) {
      await createComment(`Sorry, no open bounty found with ID ${bountyId}.`);
      return;
    }

    const bounty = bountyResult.rows[0];

    // Check if the claimant is the bounty creator
    if (bounty.creator_id === userId) {
      await createComment(`Sorry, you cannot claim your own bounty.`);
      return;
    }

    const pullRequestNumber = payload.pull_request.number;

    await client.query(
      "INSERT INTO bounty_claims (bounty_id, user_id, pull_request_number) VALUES ($1, $2, $3)",
      [bounty.id, userId, pullRequestNumber]
    );

    await createComment(
      `Thank you for your contribution! The repo owners/managers will review your code and approve it if deemed correct. In the meantime, you can check out new bounties at ${process.env.FRONTEND_URL}.`
    );
  } catch (error) {
    if (error.code === "23505") {
      // PostgreSQL unique violation error code
      await createComment(
        `⚠️ This bounty has already been claimed on another pull request. You can only claim a bounty once per open pull request.`
      );
    } else {
      console.error("Error claiming bounty:", error);
    }
  } finally {
    client.release();
  }
}
async function verifyAadhaarPan(aadhaarPan, userId) {
  const client = await pool.connect();
  try {
    // Implement your actual verification logic here
    const isVerified = true; // Placeholder for actual verification
    if (isVerified) {
      await client.query(
        "UPDATE users SET aadhaar_pan = $1, is_verified = $2 WHERE github_id = $3",
        [aadhaarPan, true, userId]
      );
      return true;
    } else {
      throw new Error("Verification failed");
    }
  } catch (error) {
    console.error("Error verifying Aadhaar/PAN:", error);
    throw error;
  } finally {
    client.release();
  }
}

// Encryption
function encryptPrivateKey(privateKey) {
  const algorithm = "aes-256-gcm";
  const key = process.env.ENCRYPTION_KEY; // Store this securely (environment variable, key management system, etc.)
  const iv = crypto.randomBytes(16); // Initialization vector

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(privateKey);
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  return {
    iv: iv.toString("hex"),
    encryptedData: encrypted.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

// Decryption
function decryptPrivateKey(encryptedData) {
  const algorithm = "aes-256-gcm";
  const key = process.env.ENCRYPTION_KEY;
  const iv = Buffer.from(encryptedData.iv, "hex");
  const authTag = Buffer.from(encryptedData.authTag, "hex");

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(
    Buffer.from(encryptedData.encryptedData, "hex")
  );
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted;
}

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`Server is running at ${PORT}`);
});
