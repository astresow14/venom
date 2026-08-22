/**
 * Deterministic person-name screening data for the master-ontology identity
 * policy. The screen must work independently of model output (categories are
 * untrusted), so it is a fixed offline heuristic, not an NER model.
 *
 * Curation rules:
 *  - Distinctly-personal given names only. Name/noun homonyms that also name
 *    real business concepts (will, may, grace, mark, taylor, hunter, …) and
 *    country homonyms (jordan, chad, india, …) are deliberately absent —
 *    blocking "Grace Period" or "Taylor Series" would gut legitimate
 *    vocabulary, and those labels carry little identity on their own.
 *  - Everything lower-case; callers compare case-insensitively.
 *
 * The screen over-blocks by design (e.g. "Grace Hopper Conference" when a
 * listed name appears): losing an odd concept is accepted, leaking a person
 * is not. It also under-blocks names outside the list — that residual risk
 * is why it is only one layer beside the category allowlist, identifier
 * regexes, sensitivity locks, and per-concept user control.
 */
export const MASTER_GIVEN_NAMES: ReadonlySet<string> = new Set([
  "aaron", "abigail", "adam", "adrian", "adriana", "ahmed", "aisha", "alan",
  "albert", "alberto", "alejandro", "alex", "alexander", "alexandra", "alexis",
  "alfred", "ali", "alice", "alicia", "alina", "allison", "alyssa", "amanda",
  "amelia", "amir", "amy", "ana", "anastasia", "andrea", "andreas", "andrei",
  "andres", "andrew", "andy", "angela", "angelica", "angelo", "anita", "ann",
  "anna", "anne", "annette", "anthony", "antonio", "ariana", "arjun", "arnold",
  "arthur", "ashley", "audrey", "austin", "barbara", "beatriz", "becky",
  "benjamin", "bernard", "beth", "betty", "beverly", "billy", "bobby", "brad",
  "bradley", "brandon", "brenda", "brendan", "brett", "brian", "brianna",
  "brittany", "brooke", "bruce", "bruno", "bryan", "caleb", "cameron",
  "camila", "carl", "carla", "carlos", "carmen", "carol", "carolina",
  "caroline", "carolyn", "carrie", "cassandra", "catherine", "cathy",
  "cecilia", "cesar", "charlene", "charles", "charlie", "charlotte", "chen",
  "cheryl", "chloe", "chris", "christian", "christina", "christine",
  "christopher", "cindy", "claire", "clara", "claudia", "colin", "connie",
  "corey", "craig", "cynthia", "dale", "dan", "dana", "daniel", "daniela",
  "danielle", "danny", "darlene", "darrell", "darren", "dave", "david",
  "deborah", "debra", "denise", "dennis", "derek", "diana", "diane", "diego",
  "dmitri", "dolores", "dominic", "don", "donald", "donna", "doris",
  "dorothy", "doug", "douglas", "duane", "dustin", "dylan", "eddie", "edgar",
  "edith", "eduardo", "edward", "edwin", "eileen", "elaine", "elena", "eli",
  "elias", "elizabeth", "ella", "ellen", "emily", "emma", "enrique", "eric",
  "erica", "erik", "erika", "erin", "ernest", "esther", "ethan", "eugene",
  "eva", "evelyn", "fatima", "felipe", "felix", "fernando", "florence",
  "frances", "francesca", "francesco", "francis", "francisco", "frank",
  "franklin", "fred", "frederick", "gabriel", "gabriela", "gabriella", "gail",
  "gary", "gavin", "geoffrey", "george", "gerald", "gilbert", "gina",
  "giovanni", "giulia", "gladys", "glenn", "gloria", "gordon", "greg",
  "gregory", "gustavo", "guy", "hannah", "hans", "harold", "harry", "hassan",
  "heather", "hector", "helen", "henry", "herbert", "hiroshi", "howard",
  "hugo", "ian", "ibrahim", "igor", "ingrid", "irene", "isaac", "isabel",
  "isabella", "ivan", "jack", "jackie", "jacob", "jacqueline", "jaime",
  "james", "jamie", "jan", "jane", "janet", "janice", "jared", "jasmine",
  "jason", "javier", "jean", "jeff", "jeffrey", "jenna", "jennifer", "jeremy",
  "jerome", "jerry", "jesse", "jessica", "jesus", "jill", "jim", "jimmy",
  "joan", "joann", "joanna", "joanne", "joaquin", "jodi", "joe", "joel",
  "johanna", "john", "johnny", "jon", "jonathan", "jorge", "jose", "josef",
  "joseph", "josh", "joshua", "juan", "juanita", "judith", "judy", "julia",
  "julian", "juliana", "julie", "julio", "justin", "kai", "karen", "karl",
  "karla", "kate", "katelyn", "katherine", "kathleen", "kathryn", "kathy",
  "katie", "katrina", "kayla", "keith", "kelly", "ken", "kenji", "kenneth",
  "kevin", "kim", "kimberly", "kirk", "kristen", "kristin", "kristina",
  "kurt", "kyle", "lance", "larry", "laura", "lauren", "laurie", "lawrence",
  "leah", "lee", "leo", "leon", "leonard", "leonardo", "leslie", "leticia",
  "lewis", "liam", "lillian", "linda", "lindsay", "lisa", "logan", "lois",
  "lonnie", "lorenzo", "lori", "lorraine", "louis", "louise", "lucas",
  "lucia", "lucille", "lucy", "luis", "luke", "lydia", "lynn", "madison",
  "manuel", "marc", "marcia", "marco", "marcos", "marcus", "margaret",
  "maria", "mariana", "marie", "marilyn", "mario", "marion", "marisa",
  "marissa", "marjorie", "marlene", "marta", "martha", "martin", "marvin",
  "mary", "mateo", "matthew", "mattias", "maureen", "maurice", "megan",
  "melanie", "melissa", "melvin", "michael", "michele", "michelle", "miguel",
  "mikhail", "mildred", "milton", "miriam", "mohammed", "monica", "nadia",
  "nancy", "naomi", "natalia", "natalie", "natasha", "nathan", "nathaniel",
  "neil", "nelson", "nicholas", "nicolas", "nicole", "nikolai", "nina",
  "noah", "nora", "norma", "norman", "olga", "oliver", "olivia", "omar",
  "oscar", "pablo", "pamela", "paolo", "patricia", "patrick", "paul",
  "paula", "pauline", "pedro", "peggy", "peter", "philip", "phillip",
  "phyllis", "pierre", "priya", "rachel", "rafael", "rahul", "raj", "ralph",
  "ramon", "randall", "randy", "raquel", "raul", "ravi", "raymond",
  "rebecca", "regina", "renee", "ricardo", "richard", "rick", "ricky",
  "rita", "robert", "roberta", "roberto", "robin", "rodney", "rodrigo",
  "roger", "roland", "ron", "ronald", "rosa", "rosemary", "ross", "roy",
  "ruben", "russell", "ruth", "ryan", "sabrina", "sally", "salvador", "sam",
  "samantha", "samuel", "sandra", "sanjay", "santiago", "sara", "sarah",
  "scott", "sean", "sebastian", "sergei", "sergio", "seth", "shannon",
  "shawn", "sheila", "shirley", "simon", "sofia", "sonia", "sophia",
  "sophie", "stacey", "stacy", "stanley", "stefan", "stephanie", "stephen",
  "steve", "steven", "stuart", "sue", "susan", "suzanne", "sven", "sylvia",
  "takeshi", "tamara", "tammy", "tanya", "tara", "tatiana", "ted", "teresa",
  "terrence", "terri", "terry", "theodore", "theresa", "thomas", "tiffany",
  "tim", "timothy", "tina", "toby", "todd", "tom", "tommy", "toni", "tony",
  "tracey", "traci", "tracy", "travis", "trevor", "troy", "tyrone", "valeria",
  "valerie", "vanessa", "veronica", "vicki", "vickie", "victor", "victoria",
  "vincent", "virginia", "vivian", "vladimir", "walter", "wanda", "warren",
  "wayne", "wei", "wendy", "wesley", "william", "willie", "xavier", "yolanda",
  "yuki", "yusuf", "yvonne", "zachary", "zoe",
]);

/** Honorific lead-ins: "Dr. Chen", "Mrs Alvarez" — a "who" regardless of the
 * following word, so the screen does not depend on knowing surnames. */
export const MASTER_HONORIFICS: ReadonlySet<string> = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "professor", "sir", "madam",
  "miss", "fr", "rev", "sgt", "capt", "lt", "col", "gen",
]);
