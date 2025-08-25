import { createClerkClient, verifyToken } from "@clerk/backend";

export interface ClerkEnv {
	CLERK_SECRET_KEY: string;
	CLERK_PUBLISHABLE_KEY: string;
}

export class ClerkHandler {
	private env: ClerkEnv;
	private clerkClient: ReturnType<typeof createClerkClient>;

	constructor(env: ClerkEnv) {
		this.env = env;
		this.clerkClient = createClerkClient({
			secretKey: env.CLERK_SECRET_KEY,
			publishableKey: env.CLERK_PUBLISHABLE_KEY,
		});
	}

	async verifyRequest(request: Request): Promise<{
		isValid: boolean;
		userId?: string;
		sessionId?: string;
		email?: string;
	}> {
		try {
			let token: string | null = null;

			// Check Authorization header first (for MCP clients)
			const authHeader = request.headers.get("Authorization");
			if (authHeader && authHeader.startsWith("Bearer ")) {
				token = authHeader.substring(7);
				console.log("Found Bearer token in Authorization header");
			}

			// Check for Clerk session token in cookies (for web clients)
			if (!token) {
				const cookieHeader = request.headers.get("Cookie");
				if (cookieHeader) {
					const cookies = Object.fromEntries(
						cookieHeader.split("; ").map((c) => {
							const [key, ...val] = c.split("=");
							return [key, val.join("=")];
						}),
					);
					// Clerk uses __clerk_db_jwt for the session token
					token =
						cookies.__clerk_db_jwt ||
						cookies.__session ||
						cookies.__client ||
						null;
					if (token) {
						console.log("Found token in cookies");
					}
				}
			}

			if (!token) {
				console.log("No token found in request");
				return { isValid: false };
			}

			console.log("Token format check:", {
				length: token.length,
				startsWithEy: token.startsWith("ey"),
				dotCount: (token.match(/\./g) || []).length,
			});

			// Verify the token using Clerk's verifyToken
			try {
				const payload = await verifyToken(token, {
					secretKey: this.env.CLERK_SECRET_KEY,
					// Add authorized parties to prevent CSRF
					authorizedParties: [
						"https://mcp-ical-server.kiwrlty0dq.workers.dev",
						"http://localhost:8787",
					],
				});

				console.log("Token verification successful:", { userId: payload.sub });

				if (payload) {
					// Get user details from Clerk
					const user = await this.clerkClient.users.getUser(payload.sub);

					return {
						isValid: true,
						userId: payload.sub,
						sessionId: payload.sid as string,
						email: user.emailAddresses[0]?.emailAddress,
					};
				}
			} catch (verifyError) {
				console.error("Token verification failed:", verifyError);
				console.error("Error details:", {
					message: (verifyError as any).message,
					stack: (verifyError as any).stack,
				});
			}

			return { isValid: false };
		} catch (error) {
			console.error("Request verification failed:", error);
			return { isValid: false };
		}
	}

	getLoginUrl(origin: string, returnUrl?: string): string {
		// Construct Clerk sign-in URL
		const clerkDomain =
			this.env.CLERK_PUBLISHABLE_KEY.split("_")[2].split("$")[0];
		const signInUrl = `https://${clerkDomain}.accounts.dev/sign-in`;

		// Add redirect URL if provided
		if (returnUrl) {
			return `${signInUrl}?redirect_url=${encodeURIComponent(returnUrl)}`;
		}

		return `${signInUrl}?redirect_url=${encodeURIComponent(origin + "/dashboard")}`;
	}

	getSignupUrl(origin: string, returnUrl?: string): string {
		// Construct Clerk sign-up URL
		const clerkDomain =
			this.env.CLERK_PUBLISHABLE_KEY.split("_")[2].split("$")[0];
		const signUpUrl = `https://${clerkDomain}.accounts.dev/sign-up`;

		// Add redirect URL if provided
		if (returnUrl) {
			return `${signUpUrl}?redirect_url=${encodeURIComponent(returnUrl)}`;
		}

		return `${signUpUrl}?redirect_url=${encodeURIComponent(origin + "/dashboard")}`;
	}

	// Generate an API token for MCP clients
	async generateMCPToken(userId: string): Promise<string> {
		// Create a long-lived token for MCP clients
		// This is a simple implementation - in production, you might want to use
		// Clerk's API to create a proper JWT or use a separate token system
		const payload = {
			userId,
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days
			iss: "ical-mcp-server",
			type: "mcp-api-token",
		};

		// Create a simple token by combining payload with a hash
		const payloadStr = JSON.stringify(payload);
		const token = btoa(payloadStr) + "." + btoa(userId + Date.now());

		return token;
	}

	// Verify an MCP token
	async verifyMCPToken(
		token: string,
	): Promise<{ isValid: boolean; userId?: string }> {
		try {
			const [payloadB64] = token.split(".");
			const payload = JSON.parse(atob(payloadB64));

			// Check expiration
			const now = Math.floor(Date.now() / 1000);
			if (payload.exp < now) {
				return { isValid: false };
			}

			// Check issuer
			if (
				payload.iss !== "ical-mcp-server" ||
				payload.type !== "mcp-api-token"
			) {
				return { isValid: false };
			}

			return { isValid: true, userId: payload.userId };
		} catch (error) {
			return { isValid: false };
		}
	}
}
