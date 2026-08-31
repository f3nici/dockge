import jwt from "jsonwebtoken";
import { R } from "redbean-node";
import { BeanModel } from "redbean-node/dist/bean-model";
import { generatePasswordHash, shake256, SHAKE256_LENGTH } from "../password-hash";

/**
 * How long a freshly issued login token stays valid.
 *
 * Long enough that "remember me" still means something across a working month,
 * short enough that a token lifted from browser storage does not stay usable
 * indefinitely.
 */
export const JWT_EXPIRES_IN = "30d";

export class User extends BeanModel {
    /**
     * Reset user password
     * Fix #1510, as in the context reset-password.js, there is no auto model mapping. Call this static function instead.
     * @param {number} userID ID of user to update
     * @param {string} newPassword Users new password
     * @returns {Promise<string>} The hash that was stored
     */
    static async resetPassword(userID : number, newPassword : string) : Promise<string> {
        const hash = await generatePasswordHash(newPassword);

        await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
            hash,
            userID
        ]);

        return hash;
    }

    /**
     * Reset this users password
     *
     * The bean keeps the hash, never the password itself: it is what gets
     * written back by any later R.store(), and what createJWT() hashes into the
     * token's "h" claim, which loginByToken compares against the stored hash.
     * @param {string} newPassword
     * @returns {Promise<void>}
     */
    async resetPassword(newPassword : string) {
        this.password = await User.resetPassword(this.id, newPassword);
    }

    /**
     * Create a new JWT for a user
     *
     * The token is a bearer credential that sits in the browser's localStorage
     * when "remember me" is on, so it is given a lifetime. Without one the only
     * thing that ever invalidated a token was a password change (which moves the
     * "h" claim) or a reset of the JWT secret, leaving a copied token usable
     * forever.
     *
     * Tokens issued before this existed carry no "exp" claim, and jwt.verify()
     * accepts a token that does not have one, so upgrading does not sign
     * everybody out.
     * @param {User} user The User to create a JsonWebToken for
     * @param {string} jwtSecret The key used to sign the JsonWebToken
     * @returns {string} the JsonWebToken as a string
     */
    static createJWT(user : User, jwtSecret : string) {
        return jwt.sign({
            username: user.username,
            h: shake256(user.password, SHAKE256_LENGTH),
        }, jwtSecret, {
            expiresIn: JWT_EXPIRES_IN,
        });
    }

}

export default User;
