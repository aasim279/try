const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

const symbol = "NIFTY";
let orderBook = [];
let tradeHistory = [];

// Get current date string in 'YYYY-MM-DD' format
function getCurrentDateString() {
    const date = new Date();
    return date.toISOString().split('T')[0];
}

// Load imbalance data for the current date
function loadImbalanceData() {
    const dateStr = getCurrentDateString();
    const imbalanceFilePath = path.join(__dirname, `${dateStr}_imbalanceData.json`);
    
    if (fs.existsSync(imbalanceFilePath)) {
        try {
            return JSON.parse(fs.readFileSync(imbalanceFilePath));
        } catch (err) {
            console.error(`Error parsing JSON file: ${imbalanceFilePath}`, err);
            return [];
        }
    } else {
        return [];
    }
}

// Save imbalance data for the current date
function saveImbalanceData(data) {
    const dateStr = getCurrentDateString();
    const imbalanceFilePath = path.join(__dirname, `${dateStr}_imbalanceData.json`);
    try {
        fs.writeFileSync(imbalanceFilePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`Error writing JSON file: ${imbalanceFilePath}`, err);
    }
}

// Fetch NIFTY current price
async function getCurrentNiftyPrice() {
    const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
    const headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br"
    };
    try {
        const response = await axios.get(url, { headers });
        return response.data.records.underlyingValue;
    } catch (err) {
        console.error('Error fetching NIFTY price:', err);
        throw err;
    }
}

// Fetch option chain data
async function fetchOptionChainData() {
    const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${symbol}`;
    const headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br"
    };
    try {
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (err) {
        console.error('Error fetching option chain data:', err);
        throw err;
    }
}

// Filter data for current week's expiry
function filterCurrentWeekExpiry(data) {
    const currentDate = new Date();
    const expiryDates = data.records.expiryDates;

    for (let expiryDate of expiryDates) {
        const expiryDateObj = new Date(expiryDate);
        if (expiryDateObj >= currentDate && expiryDateObj.getDay() === 4) {
            return expiryDate;
        }
    }

    throw new Error("Current week's expiry date not found");
}

// Calculate P&L
function calculatePnl() {
    let pnl = 0;
    for (let order of orderBook) {
        if (order.type === 'buy') {
            pnl += (order.currentPrice - order.price) * order.quantity;
        } else if (order.type === 'sell') {
            pnl += (order.price - order.currentPrice) * order.quantity;
        }
    }
    return pnl;
}

// Handle buy order
app.post('/buy', (req, res) => {
    const { symbol, price, quantity } = req.body;
    const order = { symbol, price: parseFloat(price), quantity: parseInt(quantity), type: 'buy', currentPrice: parseFloat(price) };
    orderBook.push(order);
    tradeHistory.push(order);
    res.send("Order placed successfully");
});

// Handle sell order
app.post('/sell', (req, res) => {
    const { symbol, price, quantity } = req.body;
    const order = { symbol, price: parseFloat(price), quantity: parseInt(quantity), type: 'sell', currentPrice: parseFloat(price) };
    orderBook.push(order);
    tradeHistory.push(order);
    res.send("Order placed successfully");
});

// Main page
app.get('/', async (req, res) => {
    try {
        const niftyPrice = await getCurrentNiftyPrice();
        const data = await fetchOptionChainData();
        const currentWeekExpiry = filterCurrentWeekExpiry(data);
        const optionData = data.records.data;

        const strikePrices = [...new Set(optionData.map(record => record.strikePrice))].sort((a, b) => a - b);
        const currentStrike = strikePrices.reduce((prev, curr) => Math.abs(curr - niftyPrice) < Math.abs(prev - niftyPrice) ? curr : prev);

        const relevantStrikes = strikePrices.filter(strike => currentStrike - 5 * 50 <= strike && strike <= currentStrike + 5 * 50);

        let totalCallOi = 0;
        let totalPutOi = 0;
        let totalCallCoi = 0;
        let totalPutCoi = 0;
        const records = [];

        for (let record of optionData) {
            if (record.expiryDate === currentWeekExpiry && relevantStrikes.includes(record.strikePrice)) {
                const strikePrice = record.strikePrice;
                const callLtp = record.CE?.lastPrice || 'N/A';
                const putLtp = record.PE?.lastPrice || 'N/A';
                const callOi = record.CE?.openInterest || 0;
                const putOi = record.PE?.openInterest || 0;
                const callCoi = record.CE?.changeinOpenInterest || 0;
                const putCoi = record.PE?.changeinOpenInterest || 0;
                totalCallOi += callOi;
                totalPutOi += putOi;
                totalCallCoi += callCoi;
                totalPutCoi += putCoi;

                const posCallSeller = (callOi / putOi).toFixed(2) || 0;
                const intraCallSeller = (callCoi / putOi).toFixed(2) || 0;
                const posPutSeller = (putOi / callOi).toFixed(2) || 0;
                const intraPutSeller = (putCoi / callCoi).toFixed(2) || 0;

                let md, action, color;
                if (callOi > putOi && callCoi < putCoi) {
                    md = "Range Bound Chance";
                    action = "Buy Call";
                    color = "lightgray";
                } else if (putOi > callOi && callCoi > putCoi) {
                    md = "Range Bound Chance";
                    action = "Buy Put";
                    color = "lightgray";
                } else if (callOi > putOi && callCoi > putCoi) {
                    md = "Down Trending Market";
                    action = "Buy Put";
                    color = "lightcoral";
                } else if (putOi > callOi && putCoi > callCoi) {
                    md = "Up Trending Market";
                    action = "Buy Call";
                    color = "lightgreen";
                } else {
                    action = "Neutral";
                    color = "white";
                }

                records.push({
                    strikePrice, callLtp, putLtp, callOi, putOi,
                    callCoi, putCoi, posCallSeller, intraCallSeller,
                    posPutSeller, intraPutSeller, action, md, color
                });
            }
        }

        const pnl = calculatePnl();
        const pcr = (totalPutOi / totalCallOi).toFixed(2) || 0;
        const currentPcr = (totalPutCoi / totalCallCoi).toFixed(2) || 0;
        const intraDiff = (currentPcr - pcr).toFixed(2);

        const currentStrikeData = records.find(record => record.strikePrice === currentStrike);
        const currentIntraCallSeller = currentStrikeData.intraCallSeller;
        const currentIntraPutSeller = currentStrikeData.intraPutSeller;
        const currentAction = currentIntraCallSeller > currentIntraPutSeller ? "Buy Put" : "Buy Call";

        const currentIPCR = (totalPutCoi / totalCallCoi).toFixed(2);
        const action = currentIPCR > 1.2 ? 'Buy Call' : (currentIPCR < 0.92 ? 'Buy Put' : 'Hold');
        const actionColor = currentIPCR > 1.2 ? 'lightgreen' : (currentIPCR < 0.92 ? 'lightcoral' : 'white');

        const imbalanceData = loadImbalanceData();

        const currentStrikePrice = currentStrike;
        const oneStepUpStrike = currentStrike + 50;
        const oneStepDownStrike = currentStrike - 50;

        const currentStrikeCoiData = records.find(record => record.strikePrice === currentStrikePrice);
        const oneStepUpStrikeCoiData = records.find(record => record.strikePrice === oneStepUpStrike);
        const oneStepDownStrikeCoiData = records.find(record => record.strikePrice === oneStepDownStrike);

        const newRow = {
            dateTime: new Date().toLocaleString(),
            totalCCOI: totalCallCoi,
            totalPCOI: totalPutCoi,
            currentIPCR,
            action,
            strikePrice: currentStrike,
            actionColor,
            currentStrikeCoiData: {
                callCoi: currentStrikeCoiData?.callCoi,
                putCoi: currentStrikeCoiData?.putCoi,
            },
            oneStepUpStrikeCoiData: {
                callCoi: oneStepUpStrikeCoiData?.callCoi,
                putCoi: oneStepUpStrikeCoiData?.putCoi,
            },
            oneStepDownStrikeCoiData: {
                callCoi: oneStepDownStrikeCoiData?.callCoi,
                putCoi: oneStepDownStrikeCoiData?.putCoi,
            }
        };

        imbalanceData.push(newRow);
        saveImbalanceData(imbalanceData);

        console.log(JSON.stringify(imbalanceData, null, 2)); // Log the imbalanceData to verify

        res.render('index', {
            niftyPrice, records, pnl, pcr, currentPcr, intraDiff,
            currentStrike, currentIntraCallSeller, currentIntraPutSeller,
            currentAction, imbalanceData
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Error fetching data');
    }
});
app.get('/data', (req, res) => {
    res.json({ imbalanceData });
});
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
