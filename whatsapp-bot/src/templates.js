/**
 * Guest reply templates, ported from the SKILL.md source of truth.
 *
 * Each entry:
 *   id          — stable key used everywhere else in the code (never shown to the guest)
 *   matchWhen   — plain-English description given to Gemini for intent matching
 *   reply       — exact verbatim text to send (emoji included) — never paraphrased
 *
 * NOTE: the "Car park" template in the source SKILL.md had its paragraph duplicated
 * (a copy-paste artifact). Deduped here to a single copy of the paragraph. If that was
 * intentional, restore the second copy below.
 */

export const TEMPLATES = [
  {
    id: 'casual_ack',
    matchWhen:
      'Guest sends a short pleasantry, thanks, or casual closing remark with no actual question — ' +
      'e.g. "thank you", "thanks", "ok thanks", "noted", "got it", "okay", "cool", "alright", ' +
      '"understood", a thumbs up or folded-hands emoji. Does NOT include questions or requests.',
    reply: `You're most welcome! 😊`,
  },
  {
    id: 'new_guest',
    matchWhen:
      'This is the guest\'s first message, or a generic greeting like "hi"/"hello", or they ' +
      'introduce themselves as arriving.',
    reply:
`Welcome to Swiss Garden Residences by The Boston House! 😊

Please send us a photo of your passport or Malaysian driving licence/IC via WhatsApp to +6011 5406 3854 for identity verification, as required under Malaysian law, Registration of Guests Act 1965 (Act 381).

🕒 Check-in: From 3:00 PM
🕚 Check-out: By 11:00 AM

We will send your lobby QR code and door passcode at 3:00 PM on your check-in day, after verifying your ID.

Let us know your estimated arrival time so we can assist you better.

Thank you, and enjoy your stay! 🌟`,
  },
  {
    id: 'guest_id_received',
    matchWhen: 'Guest sends a photo/document (passport, IC, driving licence) for identity verification.',
    reply:
`Thank you for providing your document for verification. We will send the check-in information, including the lift QR code and door passcode, at 3 PM on the check-in day.

Thank you, and we look forward to hosting you! 😊`,
    // NOTE: ID photos are intentionally NOT forwarded to the staff group (by request) —
    // the guest just gets this template reply. See mediaHandler.js.
  },
  {
    id: 'address',
    matchWhen: 'Guest asks for the address, directions, or location of the property.',
    reply:
`The Boston House: For your convenience, please use the following link for the exact location of the property.

SWISS GARDEN RESIDENCES
2A, Jalan Galloway, Bukit Bintang, 50150 Kuala Lumpur, Malaysia.
https://maps.app.goo.gl/rhS1YVQfn43AQvf89
https://waze.com/ul/hw283fk7b0

👉 If you're taking Grab, please set the drop-off point as "Swiss Garden Residences – Main Lobby".`,
  },
  {
    id: 'carpark',
    matchWhen: 'Guest asks about parking, car park location, fees, or tickets.',
    reply:
`The Carpark is at level 3 and above, any lot. No reservation needed. Pay at the entrance (RM12) then you will receive a QR ticket that valid for 24hours. You can enter multiple time as long as the ticket still valid.

Please take a photo of your QR ticket as a backup — in case the physical ticket is lost, you can still scan the photo to enter or exit the carpark.`,
  },
  {
    id: 'checkout_confirmed',
    matchWhen: 'Guest tells you they have already checked out / left the unit.',
    reply: `Thank you for letting us know. Wish you a safe and pleasant journey ahead! 🙏✨`,
  },
  {
    id: 'late_checkout',
    matchWhen: 'Guest asks about check-out time, late check-out, or extending their stay before leaving.',
    reply:
`Check-Out Policy:

Our standard check-out time is 11:00 AM, as we need sufficient time to prepare the room for the next guest who will check in at 3:00 PM. For guests who wish to check out later, we can accommodate a late check-out until 2:00 PM for an additional fee of RM80. This fee covers the cost of expedited cleaning with additional manpower to ensure the room is ready for the next guest on time. Please contact us in advance to confirm.

Guests who require a slightly later check-out without incurring additional charges may extend their stay until 11:30 AM.`,
  },
  {
    id: 'early_checkin',
    matchWhen: 'Guest asks about check-in time, early check-in, or arriving before standard check-in.',
    reply:
`Check-in Policy

Our standard check-in time is from 3:00 PM (15:00) onwards, including late check-ins during the early morning hours of the following day, at no extra charge.

We require time to prepare the room after the previous guest checks out to ensure it is clean and comfortable for your stay.

If you wish to check in earlier than 3:00 PM, we offer two options. First, we can arrange expedited cleaning with additional manpower for an extra fee of RM80, allowing you to check in as early as 12:30 PM.

Alternatively, if the room is ready before 3:00 PM, we will be happy to let you check in at no extra cost. Please note that the earliest possible free check-in is typically around 2:30 PM, and we can only confirm this on the day itself.

While waiting for your room to be ready, you are welcome to relax in the lobby or enjoy the swimming pool area on Level 6. Kindly note that building management requests guests to keep noise to a minimum in the lobby area.

If you arrive before your room is ready and would like to store your luggage, we can arrange this for a fee of RM30.

Thank you for your understanding, and we look forward to welcoming you!`,
  },
  {
    id: 'checkout_procedure',
    matchWhen: 'Guest asks what to do when checking out, whether they need to hand over keys, etc.',
    reply:
`If nothing is damaged and everything is kept clean, there are no formalities needed. You may simply close the door behind you when you leave.

Have a safe journey and thank you for staying with us! 😊`,
  },
  {
    id: 'pool_gym',
    matchWhen: 'Guest asks about the pool, gym, or related facilities.',
    reply:
`The swimming pool and gyms is on Level 6 and is open daily from 8:00 AM to 10:00 PM. The pool will be closed temporary for cleaning every Monday, Wednesday and Friday from 2:00PM to 4:30PM.

Access is free, and please wear a swimsuit when using the pool. Enjoy your swim!`,
  },
  {
    id: 'early_arrival_qr',
    matchWhen: 'Guest has already arrived early, or says they will arrive before the standard check-in time.',
    reply:
`If you arrive earlier, you can use this temperory QR to access the lobby lobby (scan individually)
https://drive.google.com/drive/folders/1mGPOy2DzOHJqCpJM4jIHMSRV_5UfHX6R`,
  },
  {
    id: 'dryer',
    matchWhen: 'Guest asks about a dryer machine.',
    reply:
`Hi, sorry — the dryer machine is not usable at the moment. 🙏
It is not part of the amenities, as clearly listed on the booking platform.`,
  },
  {
    id: 'deposit_fees',
    matchWhen: 'Guest asks whether a deposit or cleaning fee is required.',
    reply:
`All fees are included in your booking. We do not require any deposit, and there are no cleaning fees or hidden charges.

Additional fees will only apply if special services are requested, such as late check-out or early check-in beyond standard timings, laundry services, cleaning during your stay, luggage storage, or airport pickup. These services are not included in the standard booking and are available upon request.`,
  },
  {
    id: 'nearby_places',
    matchWhen: 'Guest asks how far attractions, food areas, or public transport are from the property.',
    reply:
`Our apartment, Swiss-Garden Residences is located in the Bukit Bintang area.
Jalan Alor food street is about 200 m away (around 5–10 minutes' walk).
Pavilion Kuala Lumpur is approximately 1.2 km away (around 15–20 minutes' walk).
Petaling Street and Berjaya Times Square are both about 1.0–1.1 km away (around 15 minutes' walk).
Hang Tuah LRT station is also nearby, around 350 m from the apartment (about 5 minutes' walk).`,
  },
  {
    id: 'room_cleaning',
    matchWhen: 'Guest asks about room cleaning, towel change, or housekeeping during their stay.',
    reply:
`Kindly note that we do not charge any cleaning fee for your room.

We are a short-stay apartment and not a hotel, so there is no daily cleaning or towel change provided during your stay.

However, if you would like cleaning service, we can arrange it for you at an additional charge of RM80 per session, which includes bedsheet and towel change.`,
  },
  {
    id: 'food_delivery',
    matchWhen: 'Guest asks about receiving food delivery or Grab orders.',
    reply: `For Grab deliveries, the rider will usually leave the food at the lobby table. You can check with the security guard there when it arrives. 😊`,
  },
  {
    id: 'luggage_storage',
    matchWhen: 'Guest asks about storing luggage before check-in or after check-out.',
    reply:
`Luggage storage fee is RM30 per day for all luggage (not per piece). The luggage will be stored in a storeroom within the same building.

Please note that we are a short-stay apartment, not a hotel, and we do not have a front desk to store luggage.

To confirm luggage storage, please reply "Yes". Once confirmed, we will send you the storage details and information. 😊 Thank you for your understanding!`,
  },
  {
    id: 'extend_stay',
    matchWhen: 'Guest asks about extending their stay for extra night(s) beyond their current booking.',
    // NOTE: no fixed reply - confirming availability needs a human to check
    // the calendar, so this is always forwarded to staff instead of getting
    // an auto-reply (same as UNMATCHED). See handler.js.
    reply: null,
  },
  {
    id: 'smoking',
    matchWhen: 'Guest asks where they can smoke, or about the smoking policy.',
    reply: `No smoking is allowed in the room. Please use the staircase area for smoking.`,
  },
  {
    id: 'ironing',
    matchWhen: 'Guest asks about ironing or where to iron clothes.',
    reply: `Please do not iron directly on the bed — an ironing board is provided for that.`,
  },
  {
    id: 'towel_usage',
    matchWhen: 'Guest asks whether towels can be used for cleaning, or about towel usage rules.',
    reply: `Towels are for shower use only. Please use the kitchen cloth provided for cleaning.`,
  },
  {
    id: 'max_occupancy',
    matchWhen: 'Guest asks how many people are allowed to stay, or about bringing extra guests.',
    reply: `The maximum occupancy is 6 persons. Over-occupancy is not allowed and may result in a penalty imposed by building management.`,
  },
  {
    id: 'quiet_hours',
    matchWhen: 'Guest asks about noise rules, quiet hours, or making noise late at night.',
    reply: `Quiet hours are from 10:00 PM to 8:00 AM. Please avoid loud noise, including TV or music. A RM100 penalty may be imposed by building management after a first warning.`,
  },
  {
    id: 'qr_not_working',
    matchWhen: 'Guest says the QR code is not working, not scanning, giving an error, or they cannot access the lobby/lift with it.',
    reply:
`Please double-check you're at the correct tower's lift first — this is the most common cause.

If your room is in North Tower, please use the North Tower lift. If your room is in South Tower, please use the South Tower lift.

If you're coming from the car park, please go to the lobby first, then switch to the correct tower's lift.`,
  },
  {
    id: 'door_lock_instructions',
    matchWhen: 'Guest asks how to unlock the unit door, or has trouble with the door lock/thumbprint scanner.',
    reply: `Please enter the door passcode followed by # to unlock. Do not press the thumbprint scanner — please enter the passcode number only.`,
  },
  {
    id: 'ac_not_working',
    matchWhen: 'Guest says the air-conditioning is not on, not working, or cannot be turned on.',
    reply:
`Aircon will automatically turn OFF when the door is fully closed. Please turn ON the wall switches:

1. One switch near the main door
2. One switch inside the bedroom

Many guests only notice one switch, so please make sure both are ON.

If you need to go in and out frequently, you may temperory use the door latch to prevent the door from fully closing so the aircon will not turn off.
https://youtube.com/shorts/J4HFS8vtRKk?feature=share`,
  },
  {
    id: 'amenities',
    matchWhen: 'Guest asks what amenities or items are provided in the unit.',
    reply:
`Amenities Provided:

6 bath towels, toilet rolls, Shower gel, Hair shampoo, Hair dryer, Iron, Drying rack, Hanger, TV, Washing machine, Refrigerator, Electric stove, Kettle, Microwave, Water filter, Pots & pans, Bowls & plates.`,
  },
  {
    id: 'wifi',
    matchWhen: 'Guest asks for the WiFi password or network name.',
    reply: `The WiFi password is written on the TV wall. Please connect to the 5G network for a faster connection.`,
  },
  {
    id: 'water_heater',
    matchWhen: 'Guest asks about hot water, shower, or says the water heater isn\'t working.',
    reply:
`Kindly note that the water heater switch is located on the wall in the bedroom. Please turn it on and allow 10–15 minutes for the water to heat up. Thank you.
https://www.youtube.com/shorts/agNmvu4CfJs?feature=share`,
  },
  {
    id: 'rubbish_disposal',
    matchWhen: 'Guest asks how or where to throw away rubbish.',
    reply:
`Hello! You may throw the trash in the rubbish room, which is located behind the lift. Thank you! 😊
https://www.youtube.com/shorts/zvzLJsivGuA`,
  },
  {
    id: 'stove',
    matchWhen: 'Guest asks how to turn on the stove or says it isn\'t working.',
    reply:
`Please switch on the power supply at the wall socket below the stove.
In Malaysia, wall sockets must be switched on (pressed down) for the appliance to work — plugging it in alone is not sufficient.

The left and right knobs control the temperature, and the centre knob is for the timer.
Please turn on the temperature knob and the timer knob to start using the stove.
https://www.youtube.com/shorts/_dnrviFHxpQ`,
  },
];

export const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));

/** Sentinel returned by the matcher when nothing matches confidently. */
export const UNMATCHED = 'UNMATCHED';

/** Fixed handoff acknowledgment sent to the guest when nothing matches (already includes " (bot)"). */
export const HANDOFF_ACK_TEXT = 'Got it, forwarding to our team now 😊 (bot)';

/**
 * Sent to the guest once they CONFIRM they want luggage storage (after the
 * luggage_storage template above asks them to confirm). See handler.js for
 * the confirmation-detection flow.
 */
export const LUGGAGE_STORAGE_CONFIRMED_TEXT =
`Hi! Please follow the instructions below for luggage storage:

• Scan the QR code to access the lobby (each guest must scan individually).

• The storeroom is located at South Tower, Level 12. Once inside the lift, scan the QR code and press Level 12.

• When you arrive at Level 12, walk to the corridor with the large window. You will find the storeroom there.
https://drive.google.com/drive/folders/18gke67ZHkkTh6RIlMcjc8Z3eBFgwZqSj

• The storeroom door passcode is 777.

• Please use the colored ribbons provided on the table to tie your luggage handles together to avoid any mix-up.

• The luggage storage fee is RM30. Kindly place the cash into the cash box, take a short video as proof, and send it to us. Thank you. 🙏

We will send you the QR code for the South Tower Level 12 storeroom shortly.`;
