const express = require('express');
const bodyParser = require('body-parser');
const {Sequelize, sequelize} = require('./model')
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)
const Op = Sequelize.Op;

/**
 * API1
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) =>{
    try {
        const {Contract} = req.app.get('models');
        const {id} = req.params;
       
        const loggedInUserProfileId = req.header('profile_id');
        const contract = await Contract.findOne({where: {id}});
        if(!contract) return res.status(404).json({"status": false, "message" : "No Contract Found."}).end();
        else { 
            //console.log("contract = ", contract);
            let clientId = contract.dataValues.ClientId;
            let contractorId = contract.dataValues.ContractorId;
            //Validation check -> return the contract only if it belongs to the profile calling
            if(clientId == loggedInUserProfileId || contractorId == loggedInUserProfileId){
                res.json(contract);
            }else{
                return res.status(404).json({"message":"No permission to view the contracts."}).end();
            }
        }
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


/**
 * API2 - GetContracts
 * Returns a list of contracts belonging to a user (client or contractor)
 */
app.get('/contracts', getProfile, async (req, res) =>{
    try {
        const {Contract} = req.app.get('models');
        const userProfileId = req.header('profile_id');
        var userCondition = { [Op.or]: [ { "ClientId" : {[Op.eq] : userProfileId }}, { "ContractorId"  : userProfileId} ]};
        const contractList = await Contract.findAll({
            where: { [Op.and]: [ userCondition, { 'status': { [Op.ne] : 'terminated' }}] } 
        });
        if(!contractList) return res.status(404).end();
        res.json(contractList);
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})



/**
 * API3 - GetUnpaidJobs
 * Get all unpaid jobs for a user (either a client or contractor), for active contracts only
 */
app.get('/jobs/unpaid', getProfile, async(req, res) => {

    try {
        const {Job} = req.app.get('models');
        const userProfileId = req.header('profile_id');
        let innerConditionSQL = sequelize.literal("SELECT id FROM `Contracts` AS `Contract` WHERE ((`Contract`.`ClientId` = " + userProfileId +
        " OR `Contract`.`ContractorId` = " + userProfileId + ") AND `Contract`.`status` = 'in_progress')");
        let unpaidJobsCondition = { [Op.and]: [ {'paid' : null}, { 'ContractId': { [Op.in] : [innerConditionSQL] }}] };
        const unpaidJobs = await Job.findAll({ where : unpaidJobsCondition});
        if(!unpaidJobs) return res.status(404).end();
        res.json(unpaidJobs);
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


/**
 * API4
 * Pay for a job from client to contractor
 */
app.post('/jobs/:job_id/pay', getProfile, async(req, res) => {
    try {
        const {job_id} = req.params;
        if(!job_id){
            return res.status(404).json({"status": false, "message" : "Not Found."}).end();
        }
        const {Job, Contract, Profile} = req.app.get('models');

        //get loggedIn user Id from header
        const loggedInUserProfileId = req.header('profile_id');

        //check for unauthorize API access - if loggedIn user exists in db
        const loggedInProfile = await Profile.findOne({where : {id : loggedInUserProfileId}});
        if(loggedInProfile == null){
            return res.status(404).json({"status": false, "message" : "Unauthorized user."}).end();
        }

        //query => SELECT ContractId, price FROM `Jobs` AS `Jobs` WHERE `Jobs`.`paid` is NULL AND `Jobs`.`id` = 1;
        let jobIdCondition = { [Op.and]: [ {'paid' : null}, { 'id': job_id }] };
        const job = await Job.findOne({attributes: ['ContractId', 'price'], where: jobIdCondition});
        if(job != null){
            let ContractId = job.dataValues.ContractId;
            let price = job.dataValues.price;
            //console.log("job ContractId, price = ", ContractId, price);

            //query => SELECT ContractorId, ClientId FROM `Contracts` AS `Contract` WHERE id = '1'
            const contractInfo = await Contract.findOne({attributes: ['ContractorId', 'ClientId'], where: {'id' : ContractId}});
            let ContractorId = contractInfo.dataValues.ContractorId;
            let ClientId = contractInfo.dataValues.ClientId;

            //validation check -> if loggedIn userProfileId doesn't match with clientId
            if(loggedInUserProfileId != ClientId){
                return res.status(404).json({"status": false, "message" : "You cannot pay for this job as this belongs to other client."}).end();
            }

            //query => SELECT balance FROM `Profiles` AS `Profiles` WHERE id = '1'
            const clientProfile = await Profile.findOne({attributes: ['balance'], where: {'id' : ClientId}});
            let balance = clientProfile.dataValues.balance;
            //console.log("clientProfile balance = ", balance);
            
            if(balance > price){
                //transfer to contractor & update info in all places
                let clientBalance = balance - price;
                let updateClientBalance = await Profile.update({ 'balance': clientBalance },{ where: { 'id' : ClientId } });
                const contractorProfile = await Profile.findOne({attributes: ['balance'], where: {'id' : ContractorId}});
                let contractorBalance = contractorProfile.dataValues.balance;
                let updateContractorBalance = await Profile.update({ 'balance': (contractorBalance + price) },{ where: { 'id' : ContractorId } });
                // console.log("updatedbalance = ", updateClientBalance, updateContractorBalance);

                //update job table with paid=1 & paymentDate=datetime for job id
                await Job.update({ 'paid': 1, 'paymentDate': new Date() },{ where: { 'id' : job_id } });

                return res.status(200).json({"status": true, "message" : "Successfully paid for this job."}).end();
            } else{
                return res.status(200).json({"status": false, "message" : "Insufficient balance to pay for this job."}).end();
            }
        } else{
            return res.status(404).json({"status": false, "message" : "Job already paid or Invalid jobId."}).end();
        }
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


/**
 * API5
 * Deposits money into the the the balance of a client
 */
app.post('/balances/deposit/:userId', getProfile, async(req, res) => {
    try {
        const {userId} = req.params;
        if(!userId){
            return res.status(404).json({"status": false, "message" : "Not Found."}).end();
        }
        const {Job, Profile} = req.app.get('models');

        //get loggedIn user Id from header
        const loggedInProfileId = req.header('profile_id');
        //check for unauthorize API access - if loggedIn user exists in db
        const loggedInProfile = await Profile.findOne({attributes : ['balance'], where : {id : loggedInProfileId}});
        if(loggedInProfile == null){
            return res.status(404).json({"status": false, "message" : "Unauthorized user."}).end();
        }

        if(loggedInProfileId == userId){
            return res.status(404).json({"status": false, "message" : "You cannot deposit balance to own account."}).end();
        }

        //check if userId(to transfer) exists in db
        const userProfile = await Profile.findOne({attributes: ['id', 'balance'], where : {id : userId}});
        console.log("userProfile = ", userProfile);
        if(userProfile == null){
            return res.status(404).json({"status": false, "message" : "User doesn't exists to deposit amount."}).end();
        }

        //get total jobs of loggedIn user & pending price to pay
        //SELECT sum(price) FROM `Jobs` AS `Jobs` WHERE `Jobs`.`paid` is NULL AND `Jobs`.`ContractId` in (SELECT id FROM `Contracts` AS `Contract` WHERE ClientId = '4' AND status != "terminated");
        let innerConditionSQL = sequelize.literal("SELECT id FROM `Contracts` AS `Contract` WHERE ClientId = " + loggedInProfileId +
                " AND `Contract`.`status` != 'terminated'");
        let jobIdCondition = { [Op.and]: [ {'paid' : null}, { 'ContractId': { [Op.in] : [innerConditionSQL] } }] };
        const totalUserJobAmountObj = await Job.findAll({
            attributes: [[sequelize.fn('sum', sequelize.col('price')), 'total_amount']],
            where: jobIdCondition
        });
        let totalOfJobsToPay = 0;
        if(totalUserJobAmountObj[0] && totalUserJobAmountObj[0].dataValues){
            totalOfJobsToPay = totalUserJobAmountObj[0].dataValues.total_amount != null ? totalUserJobAmountObj[0].dataValues.total_amount : 0 ;
        } 
        
        //transfer from loggedIn Client to user
        let transferAmount = 10; //will this amount be available from req.body??
        if(totalOfJobsToPay > 0){
            transferAmount = 0.25 * totalOfJobsToPay;
        }

        // update loggedIn client balance & updatedAt after transfer
        let loggedInClientBalance = loggedInProfile.dataValues.balance;
        console.log("loggedInClientBalance = ", loggedInClientBalance);
        if(loggedInClientBalance <= transferAmount){
            //if current balance of loggedIn user is less than transferAmount
            return res.status(404).json({"status": false, "message" : "Insufficient balance to deposit to user's account."}).end();
        }
        let updateLoggedInUserBalanceObj = await Profile.update({ 'balance': loggedInClientBalance - transferAmount },{ where: { 'id' : loggedInProfileId } });
        
        // update user profile balance & updatedAt after transfer
        let userBalance = userProfile.dataValues.balance;
        let updateUserBalanceObj = await Profile.update({ 'balance': (userBalance + transferAmount) },{ where: { 'id' : userId } });
        //console.log("updated = ", updateLoggedInUserBalanceObj, updateUserBalanceObj);

        return res.status(200).json({"status": true, "message" : "Successfully deposited amount from logeddIn user to userId account."}).end();
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


/**
 * API6
 * Returns the profession that earned the most money (sum of jobs paid) for any contactor that worked in the query time range.
 */
app.get('/admin/best-profession', async(req, res) => {
    try {
        //get start date & end date from query parameter
        let startDateQuery = req.query.start;
        let endDateQuery = req.query.end;
        if(!startDateQuery || ! endDateQuery){
            return res.status(404).json({"status": false, "message" : "Not Found."}).end();
        }
        startDateQuery = "'" + startDateQuery + " 00:00:00.0 +00:00'";
        endDateQuery = "'" + endDateQuery + " 00:00:00.0 +00:00'"

        let bestProfessionQuery = "SELECT `Profiles`.id, `Profiles`.profession, `Profiles`.type, max(`cb`.total_price) as maxProfession FROM `Profiles` AS `Profiles` INNER JOIN (SELECT b.ContractId, c.ContractorId, b.total_price from `Contracts` as `c` INNER JOIN (SELECT sum(price) as total_price, ContractId FROM `Jobs` AS `Jobs` WHERE `Jobs`.createdAt between " 
                    + startDateQuery + " and " + endDateQuery + " GROUP BY `ContractId`) as `b` on `c`.id = `b`.ContractId) as `cb` on `cb`.ContractorId = `Profiles`.id";

        const { QueryTypes } = require('sequelize');
        const records = await sequelize.query(bestProfessionQuery, {
            type: QueryTypes.SELECT
        });
        //console.log(JSON.stringify(records[0], null, 2));

        let bestProfessionStatus = false;
        let bestProfession = {};
        if(records[0].profession){
            bestProfessionStatus = true;
            bestProfession = { "bestProfession" : records[0].profession };
        }
        
        if(!bestProfessionStatus) return res.status(404).json(
            {status : bestProfessionStatus, "message" : "Unable to found best profession."}).end();
        res.json(bestProfession);
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


/**
 * API7
 * returns the clients the paid the most for jobs in the query time period. Default limit is 2.
 */
app.get('/admin/best-clients', async(req, res) => {
    try {
        let startDateQuery = req.query.start;
        let endDateQuery = req.query.end;
        if(!startDateQuery || ! endDateQuery){
            return res.status(404).json({"status": false, "message" : "Not Found."}).end();
        }
        startDateQuery = "'" + startDateQuery + " 00:00:00.0 +00:00'";
        endDateQuery = "'" + endDateQuery + " 00:00:00.0 +00:00'"
        let limit = req.query.limit || 2;

        let bestClientQuery = "SELECT `Profiles`.id, `Profiles`.firstName || ' ' || `Profiles`.lastName AS fullName, `cb`.`paid` FROM `Profiles` AS `Profiles` INNER JOIN (SELECT b.ContractId, c.ClientId, sum(b.total_price) as `paid` from `Contracts` as `c` INNER JOIN (SELECT sum(price) as total_price, ContractId FROM `Jobs` AS `Jobs` WHERE `Jobs`.createdAt between " 
                + startDateQuery + " and " + endDateQuery + " GROUP BY `ContractId`) as `b` on `c`.id = `b`.ContractId GROUP BY `c`.`ClientId`)  as `cb` on `cb`.ClientId = `Profiles`.id ORDER By cb.paid desc limit " + limit;

        const { QueryTypes } = require('sequelize');
        const records = await sequelize.query(bestClientQuery, {
            type: QueryTypes.SELECT
        });
        //console.log(JSON.stringify(records[0], null, 2));

        let bestClientStatus = false;
        let bestClients = {}
        if(records){
            bestClientStatus = true;
            bestClients = records;
        }
            
        if(!bestClientStatus) return res.status(404).json(
            {status : bestClientStatus, "message" : "Unable to found best clients."}).end();
        res.json(bestClients);
    }catch(err) {
        res.status(500).send({"message":"Some error occured"});
    }
})


module.exports = app;
